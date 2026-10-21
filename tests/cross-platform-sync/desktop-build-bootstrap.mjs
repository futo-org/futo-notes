/**
 * Makes sure a test-hook-enabled desktop binary and frontend exist before a run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './run-state.mjs';

// ── Bootstrap: ensure test-hook-enabled artifacts exist ────────
//
// The harness is meant to be run ad-hoc — user can invoke it regardless of
// whether the app is open, the server is up, or the emulator is running.
// We verify/rebuild artifacts here so a stale production build doesn't
// silently break test-hook detection.

export function ensureDesktopDebugBinary() {
  const binPath = join(REPO_ROOT, 'target', 'debug', 'futo-notes-tauri');
  if (!existsSync(binPath)) {
    console.log('Desktop debug binary missing — building with test hooks…');
    rebuildDesktopBinary();
    return;
  }
  // If dist/ lacks __testSync, the last `cargo tauri build` (or any
  // `npm run build`) produced a hooks-free bundle. Rebuild — the Rust
  // codegen embeds whatever dist/ currently contains.
  if (!distHasTestHooks()) {
    console.log(
      `dist/ has no chunk carrying ${REQUIRED_TEST_HOOKS.join(' + ')} — rebuilding desktop binary…`,
    );
    rebuildDesktopBinary();
    return;
  }
  // Provenance check: `cargo tauri dev` (and plain `cargo build`) write the
  // SAME target/debug/futo-notes-tauri path, but bake a dev config into it —
  // a dev-server devUrl and a per-worktree identifier. Launched by this
  // harness, such a binary loads its UI from a live vite dev server and
  // shares the WebKit data container with any running dev instance, which
  // silently corrupts scenarios (empty notes dirs, no-op syncs). Rebuild
  // whenever the binary on disk is not the one rebuildDesktopBinary() last
  // produced.
  //
  // The stamp also records WHICH flags that build used, so a binary produced by
  // an older harness — one that did not bake VITE_HOSTED_SYNC, say — is rebuilt
  // rather than tested. Nothing in the bundle is greppable for a flag that
  // compiles away to `false`, so the stamp is the only honest record of it.
  const stamp = join(REPO_ROOT, 'target', 'debug', '.harness-binary-stamp');
  const expectedStamp = `${statSync(binPath).mtimeMs} ${HARNESS_BUILD_SIGNATURE}`;
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== expectedStamp) {
    console.log(
      'Desktop binary was not built by this harness with these flags (a `cargo tauri dev` build, or an older harness) — rebuilding…',
    );
    rebuildDesktopBinary();
    return;
  }
  // Staleness: none of the checks above look at the SOURCE, so a second run in
  // the same checkout happily reported a verdict for the previous run's binary.
  // That cost a #89 fix a false red (fix applied, mesh re-run, identical
  // failures, `bootstrap 19ms`) and would just as easily hand out a false green
  // — the M11 failure class, one build behind. Rebuild whenever anything the
  // binary embeds is newer than the binary itself.
  const newestSource = newestSourceMtime();
  if (newestSource > statSync(binPath).mtimeMs) {
    console.log('Sources are newer than the desktop binary — rebuilding so the run tests them…');
    rebuildDesktopBinary();
  }
}

// Newest mtime across everything baked into the harness binary: the webview app
// and editor package (through dist/), the Rust workspace, and the desktop
// shell's own sources and configuration. Build outputs and dependencies are
// skipped — they are derived, and walking them would dominate the cost.
function newestSourceMtime() {
  const SKIP = new Set(['node_modules', 'target', 'dist', '.git', 'build', '.build']);
  let newest = 0;
  const visit = (path) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (!SKIP.has(entry)) visit(join(path, entry));
      }
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };
  for (const rel of [
    'src',
    'packages',
    'crates',
    'apps/tauri',
    'index.html',
    'editor.html',
    'package.json',
    'vite.config.ts',
    'Cargo.toml',
    'Cargo.lock',
  ]) {
    visit(join(REPO_ROOT, rel));
  }
  return newest;
}

// What the harness bakes into its binary. `VITE_INCLUDE_TEST_HOOKS` is what
// makes `window.__testSync` exist at all; `VITE_HOSTED_SYNC` is what makes
// `hostedSyncEnabled()` true, and without it the built bundle compiles that
// function to `return false` — the hosted flow is off, and so is the launch
// resume that reads the saved vault at boot. The hosted scenarios used to pass
// on such a binary because `__testSync.connectHosted()` drives the Rust
// commands directly and never consults the flag; anything that runs on its own
// (like the restart-at-launch scenario) does not.
const HARNESS_BUILD_ENV = {
  VITE_INCLUDE_TEST_HOOKS: 'true',
  VITE_HOSTED_SYNC: 'true',
};

/** The stamp's second field: which flags the binary on disk was built with. */
const HARNESS_BUILD_SIGNATURE = Object.entries(HARNESS_BUILD_ENV)
  .map(([name, value]) => `${name}=${value}`)
  .join(' ');

function rebuildDesktopBinary() {
  // `just build-desktop-test` runs its own cargo-clean staleness guard (see
  // the justfile recipe) before building with these flags baked in, so every
  // rebuild — local or CI — gets it, and CI doesn't pay for a second
  // identical build.
  runOrThrow('just', ['build-desktop-test'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...HARNESS_BUILD_ENV },
  });
  const binPath = join(REPO_ROOT, 'target', 'debug', 'futo-notes-tauri');
  writeFileSync(
    join(REPO_ROOT, 'target', 'debug', '.harness-binary-stamp'),
    `${statSync(binPath).mtimeMs} ${HARNESS_BUILD_SIGNATURE}`,
  );
}

// Scan every emitted chunk, not `index-*.js`[0]: a build emits a dozen
// `index-<hash>.js` chunks and only ONE carries __testSync, so reading the
// alphabetically-first one almost always concluded "built without test hooks"
// and charged the run a `cargo clean -p` plus a full relink it did not need
// (papercut pc_b1be12680b61). vite empties dist/ per build, so nothing here can
// be a leftover from an older hooks-enabled bundle.
//
// Both names are required, and in the same chunk. `__testSync` alone was enough
// while the hook was one object; the hosted half arrived later
// (futo-notes#186), so a dist/ left over from before it — or from a branch
// without it — would pass a `__testSync`-only check and then fail six scenarios
// in with "connectHosted is not a function", which reads like a product bug
// rather than a stale build.
const REQUIRED_TEST_HOOKS = ['__testSync', 'connectHosted'];

function distHasTestHooks() {
  const assetsDir = join(REPO_ROOT, 'dist', 'assets');
  if (!existsSync(assetsDir)) return false;
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .some((name) => {
      const path = join(assetsDir, name);
      return REQUIRED_TEST_HOOKS.every((needle) => fileContains(path, needle));
    });
}

function fileContains(path, needle) {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function runOrThrow(cmd, argv, opts) {
  const res = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed with exit ${res.status}`);
  }
}
