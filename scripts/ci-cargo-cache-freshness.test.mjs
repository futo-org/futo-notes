import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/ci-cargo-cache-freshness.mjs');
const pipeline = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8');

const workspaces = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Identity is passed with -c rather than two `git config` spawns per repo.
//
// Every subprocess here is wall-clock this test cannot control: 6 of these cases
// each spawn ~14 processes, which is 130-180ms locally but 1-6 of them blew
// vitest's 5s default when several CI pipelines shared one runner and starved the
// CPU ~100x (pc_a7f24bf0a15e). The assertions were never wrong, so the fix is
// headroom, not a longer timeout (M15): this file now spawns 5 fewer processes
// per case (2 git config + 3 touch).
const IDENTITY = [
  '-c',
  'user.email=ci@example.com',
  '-c',
  'user.name=CI',
  '-c',
  'commit.gpgsign=false',
];

function git(cwd, args) {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim();
}

// A throwaway repo with two commits: an unchanged crate file and one the second
// commit edits — the shape of a cargo workspace whose cache predates a change.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-cache-guard-'));
  workspaces.push(dir);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  mkdirSync(join(dir, 'crates/dep/src'), { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\n');
  writeFileSync(join(dir, 'crates/dep/src/lib.rs'), 'pub fn existing() {}\n');
  writeFileSync(join(dir, 'crates/dep/src/untouched.rs'), 'pub fn other() {}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);

  writeFileSync(join(dir, 'crates/dep/src/lib.rs'), 'pub fn existing() {}\npub fn added() {}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'add a symbol']);
  return { dir, base, head: git(dir, ['rev-parse', 'HEAD']) };
}

// Restored artifacts land with mtimes newer than the freshly checked-out
// sources, which is what makes cargo call a stale rlib fresh.
function restoreCache(dir, { stamp } = {}) {
  mkdirSync(join(dir, 'target/debug'), { recursive: true });
  writeFileSync(join(dir, 'target/debug/libdep.rlib'), 'stale artifact');
  if (stamp) writeFileSync(join(dir, 'target/.ci-source-stamp'), `${stamp}\n`);
  const past = new Date(Date.now() - 3600_000);
  for (const file of ['crates/dep/src/lib.rs', 'crates/dep/src/untouched.rs', 'Cargo.toml']) {
    // utimesSync, not `touch -d`: same effect, no subprocess (see git() above).
    utimesSync(join(dir, file), past, past);
  }
}

function runGuard(dir, args = []) {
  try {
    const stdout = execFileSync('node', [GUARD, ...args], {
      cwd: dir,
      encoding: 'utf8',
      // CI_PROJECT_DIR is pinned so the guard resolves paths inside the fixture
      // repo. CARGO_TARGET_DIR must be UNSET for the same reason: the guard
      // derives its target dir from it, so inheriting the caller's value made
      // the guard inspect a directory outside the fixture, report "no restored
      // target/", and exit 0 — five tests asserting exit 1 then failed. Green on
      // a normal Mac, red under any runner that exports CARGO_TARGET_DIR, which
      // is how it surfaced (pc_7f277346768b).
      env: { ...process.env, CI_PROJECT_DIR: dir, CARGO_TARGET_DIR: undefined },
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function mtime(dir, file) {
  return statSync(join(dir, file)).mtimeMs;
}

describe('restored cargo cache freshness guard', () => {
  it('fails --check when the restored target/ predates the checked-out sources', () => {
    const { dir, base } = makeRepo();
    restoreCache(dir, { stamp: base });

    const result = runGuard(dir, ['--check']);

    expect(result.status).toBe(1);
    expect(result.output).toContain('SKEWED');
    expect(result.output).toContain(base.slice(0, 8));
  });

  it('fails --check when the restored target/ carries no stamp at all', () => {
    const { dir } = makeRepo();
    restoreCache(dir);

    expect(runGuard(dir, ['--check']).status).toBe(1);
  });

  it('touches only the files that changed since the stamped commit, then re-stamps', () => {
    const { dir, base, head } = makeRepo();
    restoreCache(dir, { stamp: base });
    const untouchedBefore = mtime(dir, 'crates/dep/src/untouched.rs');

    const repair = runGuard(dir);

    expect(repair.status).toBe(0);
    expect(repair.output).toContain('touching 1 of 1 changed file(s)');
    expect(mtime(dir, 'crates/dep/src/lib.rs')).toBeGreaterThan(untouchedBefore);
    expect(mtime(dir, 'crates/dep/src/untouched.rs')).toBe(untouchedBefore);
    expect(readFileSync(join(dir, 'target/.ci-source-stamp'), 'utf8').trim()).toBe(head);
    expect(runGuard(dir, ['--check']).status).toBe(0);
  });

  it('touches every cargo input when the stamped commit cannot be resolved', () => {
    const { dir } = makeRepo();
    restoreCache(dir, { stamp: 'f'.repeat(40) });
    const before = mtime(dir, 'crates/dep/src/untouched.rs');

    const repair = runGuard(dir);

    expect(repair.status).toBe(0);
    expect(repair.output).toContain('stamped commit unavailable');
    expect(mtime(dir, 'crates/dep/src/untouched.rs')).toBeGreaterThan(before);
  });

  it('leaves an already-consistent tree alone', () => {
    const { dir, head } = makeRepo();
    restoreCache(dir, { stamp: head });
    const before = mtime(dir, 'crates/dep/src/lib.rs');

    expect(runGuard(dir, ['--check']).status).toBe(0);
    expect(runGuard(dir).status).toBe(0);
    expect(mtime(dir, 'crates/dep/src/lib.rs')).toBe(before);
  });

  it('stamps a cold build so the next restore knows what it holds', () => {
    const { dir, head } = makeRepo();

    expect(runGuard(dir).status).toBe(0);
    expect(readFileSync(join(dir, 'target/.ci-source-stamp'), 'utf8').trim()).toBe(head);
  });
});

// Deny-by-default sibling check (M17): the guard is only worth anything if
// EVERY job that restores a cargo target/ runs it. .setup-rust is the shared
// entry point, so a new cargo job that skips it fails here instead of dying
// forty minutes later on a phantom symbol error.
describe('every job restoring a cargo target/ runs the guard', () => {
  const blocks = new Map();
  for (const match of pipeline.matchAll(/^([A-Za-z.][\w.:-]*):[^\n]*$/gm)) {
    const start = match.index;
    const rest = pipeline.slice(start + match[0].length);
    const next = rest.search(/^\S[^\n]*:\s*(?:#.*)?$/m);
    blocks.set(
      match[1],
      pipeline.slice(start, next === -1 ? undefined : start + match[0].length + next),
    );
  }

  const cachesTarget = (name) => /^\s+- target\/$/m.test(blocks.get(name) ?? '');
  const templates = [...blocks.keys()].filter((name) => name.startsWith('.') && cachesTarget(name));
  const jobs = [...blocks.keys()].filter((name) => !name.startsWith('.'));

  it('has cargo cache templates to check', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it('runs the freshness guard from .setup-rust', () => {
    expect(blocks.get('.setup-rust')).toContain('scripts/ci-cargo-cache-freshness.mjs');
  });

  it.each(
    jobs.filter(
      (name) =>
        cachesTarget(name) ||
        templates.some((template) => (blocks.get(name) ?? '').includes(`[${template}, cache]`)),
    ),
  )('%s references .setup-rust', (name) => {
    expect(blocks.get(name)).toContain('!reference [.setup-rust, script]');
  });
});

describe('the guard script exists where CI expects it', () => {
  it('is the path .gitlab-ci.yml invokes', () => {
    expect(pipeline).toContain('node "$CI_PROJECT_DIR/scripts/ci-cargo-cache-freshness.mjs"');
    expect(existsSync(GUARD)).toBe(true);
  });
});
