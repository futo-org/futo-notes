#!/usr/bin/env node
// The ONLY sanctioned way to resolve a desktop QA target (a running FUTO Notes
// desktop process) from a port or a PID.
//
//   node scripts/qa-target.mjs list            # every desktop instance, classified
//   node scripts/qa-target.mjs pid <pid>       # verify one PID
//   node scripts/qa-target.mjs port <port>     # verify whoever listens on <port>
//   node scripts/qa-target.mjs kill            # stop THIS worktree's verified instances
//
// Exit codes: 0 verified · 2 usage · 3 REFUSED (unsafe target) · 4 no such target.
//
// WHY THIS EXISTS. 2026-08-10: a QA agent resolved a PID by matching the
// process name `futo-notes-tauri`, then sent real Cmd+Z keystrokes to it. Every
// build shares that name — `/Applications/FUTO Notes.app/Contents/MacOS/
// futo-notes-tauri` (CFBundleExecutable really is the cargo bin name), the
// per-worktree QA builds, and `just tauri-dev` — and several run at once during
// parallel QA. The lookup resolved to the INSTALLED RELEASE app, which owns the
// user's real, E2EE-synced vault at ~/Documents/futo-notes. The undo landed in
// the wrong app; the vault survived on luck (that instant happened to be a sync
// pull, not a dirty editor + autosave).
//
// So: a name is not an identity. This resolver answers "is this process safe to
// drive?" from things that cannot collide — the executable's real path, the
// worktree list of THIS repo, and the instance's own data dir / vault — and it
// fails CLOSED. Anything it cannot positively prove safe is refused, loudly.
//
// It intentionally does NOT provide any way to send OS-level input. Real
// keystrokes/clicks go to whatever the window server thinks is focused, which
// is not a property of the PID you resolved. Drive the webview instead (the
// debug build's MCP bridge — see .claude/skills/verify/references/desktop.md).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The desktop binary name every build shares — the whole reason this file
// exists. Used ONLY to enumerate candidates for classification, never to decide
// that a candidate is safe.
export const DESKTOP_BIN_NAME = 'futo-notes-tauri';

// The release app's default vault (M3). Never a QA target, and the single most
// important string in this file.
export const PROD_VAULT_RELATIVE = path.join('Documents', 'futo-notes');

const SYSTEM_INSTALL_PREFIXES = [
  '/Applications/',
  '/System/',
  '/usr/bin/',
  '/usr/local/bin/',
  '/usr/local/lib/',
  '/opt/',
  '/snap/',
  '/var/lib/flatpak/',
];

// ---------------------------------------------------------------------------
// Pure classification (unit-tested in scripts/qa-target.test.mjs)
// ---------------------------------------------------------------------------

export function parseWorktreeRoots(porcelainText) {
  return porcelainText
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

function isInside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Classify an executable path. `ok: true` only for a debug binary built inside
 * THIS worktree — everything else is refused with a code that says why.
 */
export function classifyExecPath(execPath, { worktreeRoots, selfRoot }) {
  if (!execPath) {
    return {
      ok: false,
      code: 'exec-path-unknown',
      detail: 'could not read the process executable path — refusing rather than guessing',
    };
  }

  if (execPath.includes('.app/Contents/MacOS/') || execPath.startsWith('/Applications/')) {
    return {
      ok: false,
      code: 'production-bundle',
      detail: `${execPath} is an INSTALLED APPLICATION BUNDLE — the user's production app, which owns the real vault (~/${PROD_VAULT_RELATIVE}). Never drive it, never send it input, never kill it.`,
    };
  }
  if (SYSTEM_INSTALL_PREFIXES.some((prefix) => execPath.startsWith(prefix))) {
    return {
      ok: false,
      code: 'system-install',
      detail: `${execPath} is a system-installed build (a released package), not a QA build. It resolves the real vault (~/${PROD_VAULT_RELATIVE}).`,
    };
  }

  // Longest match wins: this repo keeps its worktrees UNDER the main checkout
  // (.claude/worktrees/*), so the main root contains every worktree path and a
  // first-match lookup would attribute every instance to the main checkout.
  const owningRoot = worktreeRoots
    .filter((root) => isInside(root, execPath))
    .sort((a, b) => b.length - a.length)[0];
  if (!owningRoot) {
    return {
      ok: false,
      code: 'outside-repo',
      detail: `${execPath} is not inside any git worktree of this repo (${worktreeRoots.length} known). An unknown build has an unknown vault.`,
    };
  }
  if (/[/\\]target[/\\]release[/\\]/.test(execPath)) {
    return {
      ok: false,
      code: 'release-profile',
      detail: `${execPath} is a RELEASE-profile build. Release config carries the production identifier and resolves the real vault (M3) even when built in a worktree.`,
    };
  }
  if (!/[/\\]target[/\\]debug[/\\]/.test(execPath)) {
    return {
      ok: false,
      code: 'not-a-debug-build',
      detail: `${execPath} is inside ${owningRoot} but not under target/debug/ — only debug builds carry the dev identifier and the QA test hooks.`,
    };
  }
  // Exact owner, not containment: run from the main checkout, `isInside` would
  // accept every nested worktree's instance as "mine".
  if (selfRoot && path.resolve(owningRoot) !== path.resolve(selfRoot)) {
    return {
      ok: false,
      code: 'other-worktree',
      detail: `${execPath} belongs to worktree ${owningRoot}, not this one (${selfRoot}). It is another session's QA instance — driving it corrupts their run. Re-run this resolver from ${owningRoot} if the instance really is yours.`,
    };
  }
  return { ok: true, code: 'worktree-debug-build', owningRoot, detail: null };
}

/**
 * Classify the instance's data dir (FUTO_NOTES_DATA_DIR). Fails closed: an
 * unreadable or unset data dir means we cannot prove which vault the instance
 * writes to, so it is not a QA target.
 */
export function classifyDataDir(dataDir, { worktreeRoots }) {
  if (!dataDir) {
    return {
      ok: false,
      code: 'data-dir-unset',
      detail:
        'the process has no FUTO_NOTES_DATA_DIR, so its vault is whatever the build default resolves to — machine-global at best, the real vault at worst. Relaunch it with FUTO_NOTES_DATA_DIR="$WORKTREE_ROOT/.tauri-data".',
    };
  }
  if (!worktreeRoots.some((root) => isInside(root, dataDir))) {
    return {
      ok: false,
      code: 'data-dir-outside-repo',
      detail: `FUTO_NOTES_DATA_DIR=${dataDir} is not inside any worktree of this repo — app state (including sync watermarks) lives outside QA isolation.`,
    };
  }
  return { ok: true, code: 'data-dir-in-worktree', detail: null };
}

/**
 * Classify the vault the instance actually writes notes into (the data dir's
 * notes-dir-override.json, when present). The production vault is a hard
 * refusal; any other vault outside the worktree is a warning, because
 * `just tauri-dev` in the MAIN checkout legitimately uses the machine-global
 * ~/Documents/fake-notes — shared between parallel sessions, so QA should not
 * write there, but it is not the user's data.
 */
export function classifyVault(notesDir, { worktreeRoots, home }) {
  if (!notesDir) return { ok: true, code: 'vault-unknown', warning: null, detail: null };

  const prodVault = path.join(home, PROD_VAULT_RELATIVE);
  if (isInside(prodVault, notesDir) || isInside(notesDir, prodVault)) {
    return {
      ok: false,
      code: 'production-vault',
      detail: `this instance's vault is ${notesDir}, which is the USER'S REAL VAULT (${prodVault}). Stop. Do not drive, write to, or kill this process.`,
    };
  }
  if (!worktreeRoots.some((root) => isInside(root, notesDir))) {
    return {
      ok: true,
      code: 'vault-outside-worktree',
      warning: `vault ${notesDir} is outside this repo — it is shared with every other session on this machine. Fine to look at, do not seed fixtures into it.`,
      detail: null,
    };
  }
  return { ok: true, code: 'vault-in-worktree', warning: null, detail: null };
}

/** The whole verdict for one candidate process. Refusals accumulate. */
export function verifyTarget(candidate, context) {
  const refusals = [];
  const warnings = [];

  const exec = classifyExecPath(candidate.execPath, context);
  if (!exec.ok) refusals.push(exec);

  // Only meaningful for one of our own builds; a foreign executable is already
  // refused above and its env tells us nothing.
  if (exec.ok) {
    const dataDir = classifyDataDir(candidate.dataDir, context);
    if (!dataDir.ok) refusals.push(dataDir);
  }

  const vault = classifyVault(candidate.notesDir, context);
  if (!vault.ok) refusals.push(vault);
  else if (vault.warning) warnings.push(vault.warning);

  return {
    pid: candidate.pid,
    execPath: candidate.execPath,
    dataDir: candidate.dataDir ?? null,
    notesDir: candidate.notesDir ?? null,
    verdict: refusals.length === 0 ? 'verified' : 'REFUSED',
    refusals,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Process inspection (thin OS wrappers)
// ---------------------------------------------------------------------------

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 ? (result.stdout ?? '') : '';
}

function worktreeRoots(selfRoot) {
  const roots = parseWorktreeRoots(run('git', ['-C', selfRoot, 'worktree', 'list', '--porcelain']));
  return roots.length > 0 ? roots : [selfRoot];
}

function repoRoot() {
  const top = run('git', ['-C', HERE, 'rev-parse', '--show-toplevel']).trim();
  return top || path.resolve(HERE, '..');
}

// argv[0] is what `pgrep -f` matched on, so it is also what a name-based lookup
// would have believed. We resolve it to a real path instead.
function execPathOf(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.realpathSync(`/proc/${pid}/exe`);
    } catch {
      /* fall through to ps */
    }
  }
  const comm = run('ps', ['-p', String(pid), '-o', 'comm=']).trim();
  const candidate = comm.startsWith('/')
    ? comm
    : run('ps', ['-p', String(pid), '-ww', '-o', 'args='])
        .trim()
        .split(/\s+/)[0];
  if (!candidate) return null;
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function envOf(pid) {
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      return Object.fromEntries(
        raw
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const eq = entry.indexOf('=');
            return [entry.slice(0, eq), entry.slice(eq + 1)];
          }),
      );
    } catch {
      return null;
    }
  }
  // macOS: `ps -E` appends the environment to the command line. Values can
  // contain spaces, so a variable ends where the next `NAME=` begins.
  const blob = run('ps', ['-Eww', '-p', String(pid), '-o', 'command=']);
  if (!blob.trim()) return null;
  const env = {};
  for (const match of blob.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)/gs,
  )) {
    env[match[1]] = match[2];
  }
  return env;
}

function notesDirOf(dataDir) {
  if (!dataDir) return null;
  try {
    const override = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'notes-dir-override.json'), 'utf8'),
    );
    return typeof override.notesDir === 'string' ? override.notesDir : null;
  } catch {
    return null;
  }
}

function candidateFor(pid) {
  const execPath = execPathOf(pid);
  const env = envOf(pid);
  const dataDir = env?.FUTO_NOTES_DATA_DIR ?? null;
  return { pid, execPath, dataDir, notesDir: notesDirOf(dataDir), envReadable: env !== null };
}

/**
 * Every running process whose executable is named like the desktop app.
 *
 * Deliberately NOT `ps -o args=` split on whitespace: the production app lives
 * at `/Applications/FUTO Notes.app/…`, and splitting argv on spaces drops the
 * one process this tool most needs to name. macOS `ps -o comm=` prints the full
 * executable path with spaces intact; Linux truncates it, so read /proc there.
 */
function allCandidatePids() {
  if (process.platform === 'linux') {
    const pids = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (path.basename(fs.realpathSync(`/proc/${entry}/exe`)) === DESKTOP_BIN_NAME) {
          pids.push(Number(entry));
        }
      } catch {
        /* process exited, or not ours to read */
      }
    }
    return pids;
  }

  const pids = [];
  for (const line of run('ps', ['-axww', '-o', 'pid=,comm=']).split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    if (path.basename(match[2].trim()) === DESKTOP_BIN_NAME) pids.push(Number(match[1]));
  }
  return pids;
}

function pidListeningOn(port) {
  const viaLsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (viaLsof.length > 0) return viaLsof[0];

  const viaSs = run('ss', ['-ltnpH', `sport = :${port}`]);
  const match = /pid=(\d+)/.exec(viaSs);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const BANNER = 'qa-target: a process NAME is not an identity — every build ships the same one.';

function printVerdict(result) {
  if (result.verdict === 'verified') {
    console.log(`VERIFIED QA TARGET  pid ${result.pid}`);
    console.log(`  exec:     ${result.execPath}`);
    console.log(`  data dir: ${result.dataDir}`);
    if (result.notesDir) console.log(`  vault:    ${result.notesDir}`);
    for (const warning of result.warnings) console.log(`  warning:  ${warning}`);
    console.log('  Drive it through the webview bridge. Never send OS-level input to a PID.');
    return;
  }
  console.error(`REFUSED  pid ${result.pid}${result.execPath ? ` (${result.execPath})` : ''}`);
  for (const refusal of result.refusals) {
    console.error(`  [${refusal.code}] ${refusal.detail}`);
  }
  console.error(`  ${BANNER}`);
}

const PROD_CODES = new Set(['production-bundle', 'system-install']);

function prodAdvisory(candidates, { exclude = null } = {}) {
  const prod = candidates.filter((candidate) => {
    if (candidate.pid === exclude) return false;
    const code = classifyExecPath(candidate.execPath, { worktreeRoots: [], selfRoot: null }).code;
    return PROD_CODES.has(code);
  });
  if (prod.length === 0) return;
  console.error(
    `NOTE: the installed production app is running (pid ${prod
      .map((candidate) => candidate.pid)
      .join(
        ', ',
      )}). It owns ~/${PROD_VAULT_RELATIVE}. QA never touches it — and never sends OS-level input, which goes to the focused window, not to a PID.`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage:
  node scripts/qa-target.mjs list          every desktop instance, classified
  node scripts/qa-target.mjs pid <pid>     verify one PID  (exit 3 = refused)
  node scripts/qa-target.mjs port <port>   verify whoever listens on <port>
  node scripts/qa-target.mjs kill          stop THIS worktree's verified instances`;

function main(argv) {
  const [command, argument] = argv;
  const selfRoot = repoRoot();
  const context = { worktreeRoots: worktreeRoots(selfRoot), selfRoot, home: os.homedir() };

  if (command === 'list') {
    const candidates = allCandidatePids().map(candidateFor);
    if (candidates.length === 0) {
      console.log('no running process named futo-notes-tauri.');
      return 0;
    }
    for (const candidate of candidates) {
      const result = verifyTarget(candidate, context);
      const label = result.verdict === 'verified' ? 'ok      ' : 'REFUSED ';
      const reason = result.refusals.map((refusal) => refusal.code).join(',') || 'this worktree';
      console.log(
        `  ${label} pid ${String(candidate.pid).padStart(7)}  ${reason.padEnd(22)} ${candidate.execPath}`,
      );
    }
    prodAdvisory(candidates);
    return 0;
  }

  if (command === 'pid' || command === 'port') {
    const numeric = Number(argument);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      console.error(USAGE);
      return 2;
    }
    const pid = command === 'pid' ? numeric : pidListeningOn(numeric);
    if (!pid) {
      console.error(`nothing is listening on port ${numeric}.`);
      return 4;
    }
    const candidate = candidateFor(pid);
    if (!candidate.execPath) {
      console.error(`REFUSED  pid ${pid} — no such process, or its executable path is unreadable.`);
      return 4;
    }
    const result = verifyTarget(candidate, context);
    printVerdict(result);
    // Its own refusal already named it; this is about the OTHER app that may be
    // running while you look for a QA target.
    prodAdvisory(allCandidatePids().map(candidateFor), { exclude: pid });
    return result.verdict === 'verified' ? 0 : 3;
  }

  if (command === 'kill') {
    const candidates = allCandidatePids().map(candidateFor);
    const mine = candidates.filter(
      (candidate) => verifyTarget(candidate, context).verdict === 'verified',
    );
    for (const candidate of mine) {
      process.kill(candidate.pid, 'SIGTERM');
      console.log(`stopped pid ${candidate.pid} (${candidate.execPath})`);
    }
    if (mine.length === 0) console.log('no verified instance of this worktree is running.');
    const others = candidates.length - mine.length;
    if (others > 0)
      console.log(`left ${others} other instance(s) alone — they are not this worktree's.`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
