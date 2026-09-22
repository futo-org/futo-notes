import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/ci-cirrus-cache-mtimes.mjs');

const workspaces = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-mtimes-'));
  workspaces.push(dir);
  return dir;
}

function write(dir, rel, contents = 'x') {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function run(cwd, args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

describe('ci-cirrus-cache-mtimes', () => {
  // The bug this exists for: Cirrus untars without applying mtimes, so a
  // restored tree comes back in walk order. target/aarch64-apple-ios sorts
  // before target/release-ffi, which leaves the host-side build-script output
  // NEWER than the per-target artifact consuming it and makes cargo rebuild
  // every build-script crate on a full cache hit.
  it('leaves no restored artifact newer than another in the same tier', () => {
    const dir = scratch();
    const target = join(dir, 'target');
    const early = write(dir, 'target/aarch64-apple-ios/release-ffi/libdep.rlib');
    const late = write(dir, 'target/release-ffi/build/serde-abc/output');

    // Reproduce the scrambled ordering the untar produces.
    utimesSync(early, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    utimesSync(late, new Date(1_000_000_060_000), new Date(1_000_000_060_000));
    expect(lstatSync(late).mtimeMs).toBeGreaterThan(lstatSync(early).mtimeMs);

    run(dir, [target]);

    expect(lstatSync(late).mtimeMs).toBe(lstatSync(early).mtimeMs);
  });

  it('orders tiers by argument position so registry sources precede artifacts', () => {
    const dir = scratch();
    const registrySrc = write(dir, 'registry/src/index/serde-1.0/src/lib.rs');
    const artifact = write(dir, 'target/release-ffi/libserde.rlib');

    // Untar order put the source AFTER the artifact — cargo would call the
    // artifact stale and recompile serde.
    utimesSync(artifact, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    utimesSync(registrySrc, new Date(1_000_000_060_000), new Date(1_000_000_060_000));

    run(dir, [join(dir, 'registry'), join(dir, 'target')]);

    expect(lstatSync(registrySrc).mtimeMs).toBeLessThan(lstatSync(artifact).mtimeMs);
  });

  it('keeps every restored file older than the freshly synced working tree', () => {
    const dir = scratch();
    const artifact = write(dir, 'target/release-ffi/libcore.rlib');
    const source = write(dir, 'crates/futo-notes-core/src/lib.rs');

    run(dir, [join(dir, 'target')]);

    // A workspace source the VM sync just wrote must still win, or a real edit
    // could be skipped.
    expect(lstatSync(artifact).mtimeMs).toBeLessThan(lstatSync(source).mtimeMs);
  });

  it('treats an absent directory as a cache miss, not an error', () => {
    const dir = scratch();
    const out = run(dir, [join(dir, 'never-restored')]);
    expect(out).toMatch(/absent \(cache miss\)/);
  });

  it('does not follow symlinks out of the restored tree', () => {
    const dir = scratch();
    const outside = write(dir, 'outside/keep.txt');
    utimesSync(outside, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    mkdirSync(join(dir, 'target'), { recursive: true });
    symlinkSync(outside, join(dir, 'target/link.txt'));

    run(dir, [join(dir, 'target')]);

    expect(lstatSync(outside).mtimeMs).toBe(1_700_000_000_000);
  });

  // Red-proofing: the helper is worthless if a task restores a cache and never
  // calls it, so pin the wiring to the config that owns it.
  it('runs in every .cirrus.yml task that restores a cargo cache', () => {
    const cirrus = readFileSync(join(ROOT, '.cirrus.yml'), 'utf8');
    const tasks = cirrus.split(/^(?=\S.*_task:)/m).filter((t) => t.includes('cargo_target_cache:'));
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    for (const task of tasks) {
      expect(task).toContain('scripts/ci-cirrus-cache-mtimes.mjs');
    }
  });
});
