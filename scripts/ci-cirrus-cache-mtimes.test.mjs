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

  // Red-proofing: pin the wiring to the config that owns it. Selecting tasks by
  // "runs cargo" rather than "declares a cache" is the point: a new
  // Rust-compiling task added without caching (buildFutoNotesMacOSInternal
  // landed on main that way while this was in review) must fail here, not
  // silently build cold.
  describe('.cirrus.yml wiring', () => {
    const cirrus = readFileSync(join(ROOT, '.cirrus.yml'), 'utf8');
    const tasks = cirrus
      .split(/^(?=\S.*_task:)/m)
      .filter((t) => /_task:/.test(t.split('\n')[0]))
      .map((body) => ({ name: body.match(/^\s+name:\s*(\S+)/m)?.[1] ?? body.split(':')[0], body }));
    // A direct cargo call, or the shared iOS FFI build that wraps one.
    const RUNS_CARGO =
      /^\s+-.*(\bcargo (build|test|check|tauri|install)\b|scripts\/build-rust-ios\.sh)/m;
    const cargoTasks = tasks.filter((t) => RUNS_CARGO.test(t.body));

    it('finds the Rust-compiling tasks at all', () => {
      expect(cargoTasks.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'testRustMacOS',
          'testFutoNotesIOSNative',
          'buildFutoNotesMacOS',
          'buildFutoNotesMacOSInternal',
        ]),
      );
    });

    it.each(cargoTasks.map((t) => [t.name, t.body]))(
      '%s caches cargo and repairs mtimes before its first cargo call',
      (_name, body) => {
        expect(body).toContain('cargo_registry_cache:');
        expect(body).toContain('cargo_target_cache:');
        expect(body).toMatch(/CARGO_INCREMENTAL: "0"/);

        const stamp = body.indexOf(
          'scripts/ci-cirrus-cache-mtimes.mjs "$HOME/.cargo/registry" target',
        );
        const fresh = body.indexOf('node scripts/ci-cargo-cache-freshness.mjs');
        const firstCargo = body.search(RUNS_CARGO);
        expect(stamp).toBeGreaterThan(-1);
        expect(fresh).toBeGreaterThan(stamp);
        expect(firstCargo).toBeGreaterThan(fresh);
      },
    );

    // Naming ANY cache under upload_caches disables the automatic upload for
    // all of them, so a cache missing from the list is silently never saved.
    it.each(cargoTasks.map((t) => [t.name, t.body]))(
      '%s uploads every cache it declares',
      (_name, body) => {
        const declared = [...body.matchAll(/^ {2}(\w+)_cache:/gm)].map((m) => m[1]).sort();
        const listed = body.match(/upload_caches:\n((?:\s+- \w+\n?)+)/);
        expect(listed).not.toBeNull();
        const uploaded = [...listed[1].matchAll(/- (\w+)/g)].map((m) => m[1]).sort();
        expect(uploaded).toEqual(declared);
      },
    );
  });
});
