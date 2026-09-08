#!/usr/bin/env node
// `just orient` — where am I, what do I own, what is dirty, and what is already
// known to hurt in the area I am about to touch. One screen, computed in under
// two seconds, so a session never has to rediscover the slot model from the
// verify skill or ask "which checkout is this?".
//
// Also the payload of the SessionStart hook (scripts/hooks/session-orient.mjs).
//
//   just orient           # text
//   just orient --json    # the same facts as JSON
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENV_NAMES, portsFor, slotOf } from './lib/slot.mjs';

const HOME = os.homedir();
const QA_STATE = process.env.FUTO_QA_STATE_DIR || path.join(HOME, '.futo-notes-qa');
const SWEEP_LAST_RUN =
  process.env.FUTO_PAPERCUT_SWEEP_LAST_RUN ||
  path.join(HOME, '.local', 'state', 'futo-notes-papercut-sweep', 'last-run.json');

// Which papercut tags usually mean "this area". Keys are matched as path
// prefixes against the files in the diff; two-segment keys win over one.
export const AREA_TAGS = {
  'apps/ios': ['ios', 'ios-qa'],
  'apps/android': ['android'],
  'apps/tauri': ['desktop', 'tauri'],
  'packages/editor': ['editor'],
  crates: ['rust', 'sync'],
  src: ['svelte', 'desktop', 'editor'],
  tests: ['testing', 'tests', 'test', 'test-infra', 'editor-gauntlet', 'qa'],
  scripts: ['tooling', 'ci', 'gates', 'agents'],
  '.claude': ['agents', 'skills', 'tooling', 'workflow', 'qa'],
  docs: ['docs'],
  '.gitlab-ci.yml': ['ci'],
  justfile: ['tooling'],
};

/** Map changed paths to AREA_TAGS keys (longest matching prefix). */
export function areasOf(changedFiles) {
  const keys = Object.keys(AREA_TAGS).sort((a, b) => b.length - a.length);
  const areas = new Set();
  for (const file of changedFiles) {
    const key = keys.find((k) => file === k || file.startsWith(k + '/'));
    if (key) areas.add(key);
  }
  return areas;
}

/** Open cuts whose tags intersect the tags of the touched areas, major first. */
export function matchPapercuts(openCuts, areas) {
  const wanted = new Set();
  for (const area of areas) for (const tag of AREA_TAGS[area] ?? []) wanted.add(tag);
  if (wanted.size === 0) return [];
  const rank = { blocker: 0, major: 1, minor: 2 };
  return openCuts
    .filter((cut) => (cut.tags ?? []).some((tag) => wanted.has(tag)))
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.ts.localeCompare(b.ts));
}

/** Parse the append-only log into the open set (cuts without a resolve). */
export function loadPapercuts(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return { open: [], total: 0 };
  const entries = fsImpl
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const resolved = new Set(entries.filter((e) => e.kind === 'resolve').map((e) => e.id));
  const cuts = entries.filter((e) => e.kind === 'cut');
  return { open: cuts.filter((c) => !resolved.has(c.id)), total: cuts.length };
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Gather every fact `formatOrientation` prints. Read-only; never fetches. */
export function gather(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { root: null, error: `${cwd} is not inside a git checkout` };
  const commonDir = path.resolve(root, git(['rev-parse', '--git-common-dir'], root) || '.git');
  const gitDir = path.resolve(root, git(['rev-parse', '--git-dir'], root) || '.git');
  const primary = path.dirname(commonDir);
  const linked = primary !== root;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const counts = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], root);
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
  const status = git(['status', '--porcelain'], root) ?? '';
  const dirtyFiles = status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  const committed = (git(['diff', '--name-only', 'origin/main...HEAD'], root) ?? '')
    .split('\n')
    .filter(Boolean);
  const changedFiles = [...new Set([...committed, ...dirtyFiles])];

  const targetDir = path.join(root, 'target');
  const profiles = fs.existsSync(targetDir)
    ? fs
        .readdirSync(targetDir)
        .filter((d) => fs.existsSync(path.join(targetDir, d, '.fingerprint')))
    : [];

  const devices = [];
  const devDir = path.join(QA_STATE, 'devices');
  if (fs.existsSync(devDir)) {
    for (const f of fs.readdirSync(devDir)) {
      const m = f.match(/^(ios|android)-(.+)\.json$/);
      const owner = m && readJson(path.join(devDir, f));
      if (owner?.worktree === root) devices.push(`${m[1]} ${m[2]}`);
    }
  }
  let server = null;
  const srvDir = path.join(QA_STATE, 'server');
  if (fs.existsSync(srvDir)) {
    for (const d of fs.readdirSync(srvDir)) {
      const meta = readJson(path.join(srvDir, d, 'meta.json'));
      if (meta?.worktree === root) server = meta;
    }
  }

  const papercuts = loadPapercuts(path.join(root, '.papercuts.jsonl'));
  const purpose = readJson(path.join(gitDir, 'futo-purpose.json'));
  const sweep = readJson(SWEEP_LAST_RUN);

  return {
    root,
    primary,
    linked,
    branch,
    ahead,
    behind,
    dirty: dirtyFiles.length,
    changedFiles,
    slot: slotOf(root),
    ports: portsFor(root),
    nodeModules: fs.existsSync(path.join(root, 'node_modules')),
    target: { exists: fs.existsSync(targetDir), profiles },
    devices,
    server,
    purpose,
    papercuts: {
      open: papercuts.open.length,
      total: papercuts.total,
      matched: matchPapercuts(papercuts.open, areasOf(changedFiles)).slice(0, 6),
    },
    sweep,
  };
}

export function formatOrientation(d) {
  if (!d.root) return `orient: ${d.error}`;
  const L = [];
  L.push(`FUTO Notes orientation — ${d.root}`);
  L.push(
    d.linked
      ? `  worktree: linked · primary checkout is ${d.primary}`
      : '  worktree: PRIMARY checkout (the user works here — prefer `just wt new <name>` for agent work)',
  );
  const drift =
    d.ahead === null
      ? 'no origin/main to compare'
      : `${d.ahead} ahead / ${d.behind} behind origin/main`;
  L.push(
    `  branch:   ${d.branch ?? '?'} · ${drift} · ${d.dirty} dirty file${d.dirty === 1 ? '' : 's'}`,
  );
  if (d.purpose?.name) {
    L.push(
      `  purpose:  ${d.purpose.name}${d.purpose.created ? ` · created ${String(d.purpose.created).slice(0, 10)}` : ''}${d.purpose.session ? ` · session ${String(d.purpose.session).slice(0, 8)}` : ''}`,
    );
  }
  const p = d.ports;
  L.push(
    `  slot ${d.slot} · ${Object.entries(ENV_NAMES)
      .map(([key, name]) => `${name}=${p[key]}`)
      .join(' ')}`,
  );
  const nm = d.nodeModules ? 'node_modules ok' : 'node_modules MISSING → just install';
  const tg = d.target.exists
    ? `target/ ok (${d.target.profiles.join(', ') || 'no profiles built'})`
    : 'target/ cold (first cargo build ahead; `just wt new` would have reflinked one)';
  L.push(`  caches:   ${nm} · ${tg}`);
  L.push(
    `  devices:  ${d.devices.length ? d.devices.join(', ') + ' (claimed by this worktree)' : 'none claimed (just qa-claim <ios|android>)'}`,
  );
  L.push(
    `  qa server: ${d.server ? `${d.server.url ?? 'running'} (just qa-server-stop)` : 'not running (just qa-server)'}`,
  );
  const pc = d.papercuts;
  L.push(
    `  papercuts: ${pc.open} open of ${pc.total}${pc.matched.length ? ` · ${pc.matched.length} touch the areas in your diff:` : ' · none tagged for the areas in your diff'}`,
  );
  for (const cut of pc.matched) {
    L.push(`    [${cut.severity ?? 'minor'}] ${cut.id} ${String(cut.text).slice(0, 110)}`);
  }
  if (d.sweep) {
    const when = String(d.sweep.finishedAt ?? d.sweep.startedAt ?? '').slice(0, 10);
    L.push(
      `  papercut sweep: last run ${when} ${d.sweep.status}${d.sweep.mrUrl ? ` → ${d.sweep.mrUrl}` : ''}`,
    );
  }
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = gather(process.cwd());
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(formatOrientation(data) + '\n');
  process.exit(data.root ? 0 : 1);
}
