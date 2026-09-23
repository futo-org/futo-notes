#!/usr/bin/env node
// `just wt` — the worktree lifecycle this repo never had.
//
// Worktrees had a birth (`git worktree add`, EnterWorktree, mr-qa's per-MR
// checkouts) but no death: on 2026-09-05 this machine held 123 of them, 86 with
// a cargo target/ (19 over 100 GB), 7 for branches already merged and 50
// untouched since July. `just qa-gc` reaps devices, nothing reaped checkouts.
//
//   just wt new <name> [--branch <b>] [--base origin/main] [--no-install] [--no-target]
//       sibling checkout ../<repo>-<name>, deps installed, target/ reflink-cloned
//       from the primary checkout (btrfs / APFS; skipped with a note elsewhere),
//       purpose recorded, ports printed.
//   just wt list
//   just wt gc [--apply] [--idle-days 30] [--sizes] [--no-fetch]
//       dry run by default. Candidates: branch merged into origin/main, or no
//       commit in --idle-days AND a clean tree. NEVER the primary checkout, the
//       worktree you are standing in, or anything with uncommitted changes —
//       `git worktree remove` without --force is the second lock on that door.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { envLines } from './lib/slot.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const info = (msg) => process.stderr.write(msg + '\n');
const die = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};

function git(args, cwd, { check = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (check && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

/** `git worktree list --porcelain` → [{ path, head, branch, detached, bare }]. */
export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false };
      out.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
  }
  return out;
}

/** The checkout that owns .git — worktrees hang off it. */
export function primaryRoot(cwd) {
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  return path.dirname(path.resolve(cwd, common));
}

/** ../<repo>-<name>, the naming convention every human-made worktree here uses. */
export function siblingPath(primary, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`worktree name '${name}' must be [A-Za-z0-9._-] and start alphanumeric`);
  }
  return path.join(path.dirname(primary), `${path.basename(primary)}-${name}`);
}

/** How to clone target/ cheaply on this platform, or null when it cannot be cheap. */
export function cloneTargetCommand(platform, src, dst) {
  if (platform === 'darwin') return ['cp', ['-Rc', src, dst]];
  if (platform === 'linux') return ['cp', ['-R', '--reflink=always', src, dst]];
  return null;
}

/**
 * Pure gc decision for one worktree.
 * @returns {{ candidate: boolean, reason: string|null, protectedBy: string|null }}
 */
export function classifyWorktree(wt, { now, idleDays, primary, current }) {
  if (wt.bare) return { candidate: false, reason: null, protectedBy: 'bare' };
  if (path.resolve(wt.path) === path.resolve(primary))
    return { candidate: false, reason: null, protectedBy: 'primary' };
  if (current && path.resolve(wt.path) === path.resolve(current))
    return { candidate: false, reason: null, protectedBy: 'current' };
  if (wt.missing) return { candidate: true, reason: 'missing', protectedBy: null };
  if (wt.dirty > 0) return { candidate: false, reason: null, protectedBy: 'dirty' };
  if (wt.merged) return { candidate: true, reason: 'merged', protectedBy: null };
  const ageDays = wt.lastCommitMs ? (now - wt.lastCommitMs) / DAY_MS : null;
  if (ageDays !== null && ageDays > idleDays)
    return { candidate: true, reason: `idle ${Math.floor(ageDays)}d`, protectedBy: null };
  return { candidate: false, reason: null, protectedBy: null };
}

function inspect(wt, primary, { fetched }) {
  if (!fs.existsSync(wt.path)) return { ...wt, missing: true, dirty: 0 };
  const status = git(['status', '--porcelain'], wt.path, { check: false });
  const dirty = status === null ? 1 : status.split('\n').filter(Boolean).length;
  const lastCommit = git(['log', '-1', '--format=%ct', wt.head ?? 'HEAD'], primary, {
    check: false,
  });
  const merged =
    fetched && wt.head
      ? spawnSync('git', ['merge-base', '--is-ancestor', wt.head, 'origin/main'], {
          cwd: primary,
        }).status === 0
      : false;
  return {
    ...wt,
    missing: false,
    dirty,
    merged,
    lastCommitMs: lastCommit ? Number(lastCommit) * 1000 : null,
  };
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else flags._.push(a);
  }
  return flags;
}

function cmdNew(flags) {
  const name = flags._[0];
  if (!name)
    die(
      'usage: just wt new <name> [--branch <b>] [--base origin/main] [--no-install] [--no-target]',
    );
  const primary = primaryRoot(process.cwd());
  const dest = siblingPath(primary, name);
  const branch = typeof flags.branch === 'string' ? flags.branch : name;
  const base = typeof flags.base === 'string' ? flags.base : 'origin/main';
  if (fs.existsSync(dest)) die(`${dest} already exists`);

  const remoteMatch = base.match(/^([^/]+)\/(.+)$/);
  if (remoteMatch) {
    info(`fetching ${base}…`);
    git(['fetch', '--quiet', remoteMatch[1], remoteMatch[2]], primary);
  }
  info(`git worktree add -b ${branch} ${dest} ${base}`);
  git(['worktree', 'add', '-b', branch, dest, base], primary);

  const gitDir = path.resolve(dest, git(['rev-parse', '--git-dir'], dest));
  fs.writeFileSync(
    path.join(gitDir, 'futo-purpose.json'),
    JSON.stringify(
      {
        name,
        branch,
        base,
        created: new Date().toISOString(),
        session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        by: os.userInfo().username,
      },
      null,
      2,
    ) + '\n',
  );

  if (!flags['no-install']) {
    info('pnpm install…');
    const r = spawnSync('pnpm', ['install'], { cwd: dest, stdio: 'inherit' });
    if (r.status !== 0) info('pnpm install failed — run `just install` in the worktree');
  }

  if (!flags['no-target']) {
    const src = path.join(primary, 'target');
    const dst = path.join(dest, 'target');
    const cmd = cloneTargetCommand(process.platform, src, dst);
    if (!fs.existsSync(src))
      info('no target/ in the primary checkout to clone — first cargo build will be cold');
    else if (!cmd) info(`no cheap clone on ${process.platform} — first cargo build will be cold`);
    else {
      info(`cloning target/ (${cmd[0]} ${cmd[1].join(' ')})…`);
      const r = spawnSync(cmd[0], cmd[1], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
      if (r.status !== 0) {
        fs.rmSync(dst, { recursive: true, force: true });
        info(
          `clone skipped (${(r.stderr || '').trim().split('\n')[0] || 'copy failed'}) — a full copy would cost real disk, so the first cargo build will be cold`,
        );
      }
    }
  }

  process.stdout.write(`${dest}\n`);
  info('');
  info(`worktree ready: ${dest} (branch ${branch}, base ${base})`);
  info('ports for this worktree:');
  info(envLines(dest));
  info(`next: cd ${dest} && just orient`);
}

function collect(primary, { fetch }) {
  let fetched = false;
  if (fetch) {
    fetched =
      spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: primary }).status === 0;
    if (!fetched) info('warning: could not fetch origin/main — merged-ness uses the local ref');
    fetched = true;
  } else {
    fetched =
      git(['rev-parse', '--verify', '--quiet', 'origin/main'], primary, { check: false }) !== null;
  }
  const list = parseWorktrees(git(['worktree', 'list', '--porcelain'], primary));
  return list.map((wt) => inspect(wt, primary, { fetched }));
}

const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');

function cmdList() {
  const primary = primaryRoot(process.cwd());
  const rows = collect(primary, { fetch: false });
  process.stdout.write(`LAST        DIRTY MERGED  BRANCH                                PATH\n`);
  for (const wt of rows) {
    process.stdout.write(
      `${fmtDate(wt.lastCommitMs).padEnd(11)} ${String(wt.missing ? '?' : wt.dirty).padStart(5)} ${(wt.merged ? 'yes' : 'no').padEnd(7)} ${(wt.branch ?? (wt.detached ? '(detached)' : '?')).slice(0, 37).padEnd(37)} ${wt.path}\n`,
    );
  }
}

function cmdGc(flags) {
  const primary = primaryRoot(process.cwd());
  const current = git(['rev-parse', '--show-toplevel'], process.cwd(), { check: false });
  const idleDays = Number(flags['idle-days'] ?? 30);
  const apply = flags.apply === true;

  git(['worktree', 'prune'], primary);
  const rows = collect(primary, { fetch: flags['no-fetch'] !== true });
  const now = Date.now();
  const decided = rows.map((wt) => ({
    ...wt,
    ...classifyWorktree(wt, { now, idleDays, primary, current }),
  }));
  const candidates = decided.filter((d) => d.candidate);
  const protectedCounts = {};
  for (const d of decided.filter((d) => d.protectedBy)) {
    protectedCounts[d.protectedBy] = (protectedCounts[d.protectedBy] ?? 0) + 1;
  }

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ apply, idleDays, candidates, protectedCounts }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(
      `worktree gc (${apply ? 'APPLY' : 'dry run'}) — ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} of ${decided.length} worktrees; idle threshold ${idleDays}d\n`,
    );
    process.stdout.write(
      `  REASON      LAST        SIZE    BRANCH                            PATH\n`,
    );
    for (const d of candidates) {
      const size = flags.sizes && !d.missing ? duHuman(d.path) : '';
      process.stdout.write(
        `  ${d.reason.padEnd(11)} ${fmtDate(d.lastCommitMs).padEnd(11)} ${size.padEnd(7)} ${(d.branch ?? '(detached)').slice(0, 33).padEnd(33)} ${d.path}\n`,
      );
    }
    const prot = Object.entries(protectedCounts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    process.stdout.write(`  never removed: ${prot || 'nothing protected'}\n`);
    if (!apply && candidates.length) {
      process.stdout.write(
        `  re-run with --apply to remove them (add --sizes to see disk first)\n`,
      );
    }
  }

  if (!apply) return;
  let removed = 0;
  for (const d of candidates) {
    try {
      if (d.missing) {
        git(['worktree', 'remove', '--force', d.path], primary, { check: false });
      } else {
        // No --force: git itself refuses a dirty tree, so even a race with an
        // agent that just started editing cannot lose work.
        git(['worktree', 'remove', d.path], primary);
      }
      if (d.branch && d.merged) git(['branch', '-d', d.branch], primary, { check: false });
      removed++;
      info(`removed ${d.path}`);
    } catch (error) {
      info(`kept ${d.path}: ${error.message.split('\n')[0]}`);
    }
  }
  info(`removed ${removed} of ${candidates.length}; devices they owned: just qa-gc`);
}

function duHuman(p) {
  const r = spawnSync('du', ['-sh', p], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\t')[0].trim() : '?';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    if (cmd === 'new') cmdNew(flags);
    else if (cmd === 'list') cmdList();
    else if (cmd === 'gc') cmdGc(flags);
    else
      die(
        'usage: just wt new <name> [--branch b] [--base ref] | just wt list | just wt gc [--apply] [--idle-days N] [--sizes]',
        2,
      );
  } catch (error) {
    die(error.message);
  }
}
