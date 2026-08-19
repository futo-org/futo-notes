import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CAVEATED,
  DEFAULT_HOST,
  DEFAULT_USER,
  EXIT_LOCKED,
  buildLockScript,
  buildUnlockScript,
  EXIT_MOVED,
  EXIT_REFUSED,
  GRADLE_JDK_CANDIDATES,
  REFUSED,
  REMOTE_CARGO_TARGET_DIR,
  RSYNC_EXCLUDES,
  buildDoctorScript,
  buildRunScript,
  classifyRecipe,
  ndkVersionFromGradle,
  parseCliArgs,
  parseDoctorOutput,
  parseJustAliases,
  remoteEnvPreamble,
  shQuote,
} from './remote-test.mjs';
import { parseJustRecipes } from './check-agent-docs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');
const gradle = readFileSync(join(ROOT, 'apps/android/app/build.gradle.kts'), 'utf8');
const aliases = parseJustAliases(justfile);
const recipes = parseJustRecipes(justfile);

const classify = (name) => classifyRecipe(name, { aliases, recipes });

function lockScript(overrides = {}) {
  return buildLockScript({
    remoteDir: '$HOME/ci/futo-main',
    holder: 'who=justin@mac',
    forceLock: false,
    nonce: 'test-nonce-0001',
    ...overrides,
  });
}

function runScript(overrides = {}) {
  return buildRunScript({
    remoteDir: '$HOME/ci/futo-main',
    sourceRepo: '$HOME/Developer/futo-notes',
    mode: 'git',
    sha: 'abc1234def',
    recipe: 'test-rust-full',
    recipeArgs: [],
    nonce: 'test-nonce-0001',
    ndkVersion: '28.2.13676358',
    ...overrides,
  });
}

describe('macOS-only deny-list', () => {
  // The instruction this tool encodes is "move any testing that doesn't
  // require macOS/iOS to jfedora" — so the ones that DO require macOS have to
  // be refused by name, not merely documented as a bad idea.
  it.each([
    'build-rust-ios',
    'build-ios-native',
    'test-ios-native',
    'ios-native',
    'ios-native-device',
    'deploy-ios',
    'lint-swift',
    'sim-boot',
    'sim-screenshot',
    'sim-logs',
    'sim-container',
    'qa-clone-target',
  ])('refuses %s as macOS-only', (recipe) => {
    const verdict = classify(recipe);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/Xcode|iOS simulator|swift-format|APFS/);
  });

  it('refuses a macOS-only recipe reached through its justfile alias', () => {
    // `alias in := ios-native` — a name-only deny-list is bypassable here.
    expect(aliases.get('in')).toBe('ios-native');
    const verdict = classify('in');
    expect(verdict.allowed).toBe(false);
    expect(verdict.recipe).toBe('ios-native');
    expect(verdict.reason).toContain('alias for');
  });

  it('refuses the desktop suites whose whole point is the shipped web engine', () => {
    for (const recipe of ['test-desktop-smoke', 'perf-course', 'factory-judge']) {
      const verdict = classify(recipe);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/WKWebView/);
    }
  });

  it('refuses recipes that need root or manage the local machine', () => {
    expect(classify('deploy-rpm').reason).toMatch(/sudo/);
    expect(classify('qa-claim').reason).toMatch(/device pool/);
    expect(classify('tauri-dev').reason).toMatch(/interactive/);
  });

  it('refuses a recipe that does not exist, before touching the network', () => {
    const verdict = classify('test-rust-fulll');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('not a recipe');
  });

  it('names real recipes, so a renamed recipe cannot silently become allowed', () => {
    const denied = REFUSED.filter(([m]) => typeof m === 'string').map(([m]) => m);
    const absent = denied.filter((name) => !recipes.has(name));
    // `perf-course` is deliberately pre-denied: it lands with the desktop
    // obstacle course, and its debug-build timings are only comparable to other
    // runs on the same machine — a Linux run against Mac baselines is noise.
    // When it exists, drop it from this exception list (the assertion will say so).
    expect(absent).toEqual(['perf-course']);
  });

  it('the regex matchers cover the families they claim', () => {
    for (const recipe of ['sim-boot', 'sim-screenshot', 'factory-judge', 'factory-visual']) {
      expect(recipes.has(recipe), `${recipe} is no longer a justfile recipe`).toBe(true);
      expect(classify(recipe).allowed).toBe(false);
    }
  });
});

describe('portable suites', () => {
  it.each(['check', 'test-rust-full', 'test-full', 'build-android-native', 'test-android-native'])(
    'allows %s',
    (recipe) => {
      expect(classify(recipe).allowed).toBe(true);
    },
  );

  it('allows check with no caveat — nothing in it touches a real web engine', () => {
    const verdict = classify('check');
    expect(verdict.allowed).toBe(true);
    expect(verdict.caveats).toEqual([]);
  });

  it('allows the rust workspace with no caveat', () => {
    expect(classify('test-rust-full').caveats).toEqual([]);
  });

  it('caveats the suites that boot a browser engine', () => {
    expect(classify('test-e2e-full').caveats.join(' ')).toMatch(/Chromium\/WebKit/);
    expect(classify('test-cross-platform').caveats.join(' ')).toMatch(/WebKitGTK/);
    // prepush is allowed but must never read as a substitute for the Mac.
    expect(classify('prepush').caveats.join(' ')).toMatch(/NOT a licence to skip the Mac/);
  });

  it('warns that two cross-platform sync runs in one remote worktree share a slot', () => {
    expect(classify('test-cross-platform').caveats.join(' ')).toMatch(/same remote worktree/);
  });

  it('every caveated name is a real recipe', () => {
    for (const [matcher] of CAVEATED) {
      if (typeof matcher === 'string') expect(recipes.has(matcher)).toBe(true);
    }
  });
});

describe('remote environment', () => {
  it('sources nvm, because ssh runs a non-interactive shell with no profile', () => {
    const preamble = remoteEnvPreamble({ ndkVersion: '28.2.13676358' });
    expect(preamble).toContain('NVM_DIR="$HOME/.nvm"');
    expect(preamble).toContain('nvm.sh');
    expect(preamble).toContain('$HOME/.local/bin');
    expect(preamble).toContain('$HOME/.cargo/bin');
    // The sync test server shells out to `bun`, which lives in ~/.bun/bin and
    // is absent from a non-interactive PATH — the suite died there once.
    expect(preamble).toContain('$HOME/.bun/bin');
  });

  it('never relocates the cargo target dir, and clears an inherited one', () => {
    // Two suites in this repo assume the repo-local target/ and BOTH broke on a
    // relocated CARGO_TARGET_DIR: tests/lib/tauri-instance.mjs resolves the
    // debug binary as <repoRoot>/target/debug (ENOENT after an 84s build), and
    // scripts/ci-cargo-cache-freshness.mjs inspected a directory that did not
    // exist, so its tests saw exit 0 where they assert 1 — five `remote-check`
    // failures that do not reproduce on the Mac.
    const preamble = remoteEnvPreamble({ ndkVersion: '28.2.13676358' });
    expect(preamble).toContain('unset CARGO_TARGET_DIR');
    expect(preamble).not.toMatch(/export CARGO_TARGET_DIR/);
    expect(REMOTE_CARGO_TARGET_DIR).toBeNull();
    for (const recipe of ['test-cross-platform', 'prepush', 'test-rust-full', 'check']) {
      expect(runScript({ recipe })).not.toMatch(/export CARGO_TARGET_DIR/);
    }
  });

  it('pins a Gradle-supported JDK, because Fedora defaults to one Gradle rejects', () => {
    // Gradle 8.14.3 cannot run on Java 25 and says so only as
    // "What went wrong: 25.0.4" — naming neither Java nor the constraint. The
    // Rust .so and bindings built fine; only gradle died.
    const preamble = remoteEnvPreamble({ ndkVersion: '28.2.13676358' });
    expect(preamble).toContain('export JAVA_HOME="$candidate"');
    expect(preamble).toContain(
      '$FUTO_REMOTE_JAVA_HOME'.replace('$', '${FUTO_REMOTE_JAVA_HOME:-}').slice(0, 0) +
        '${FUTO_REMOTE_JAVA_HOME:-}',
    );
    for (const jdk of GRADLE_JDK_CANDIDATES) expect(preamble).toContain(jdk);
    // 21 before 17, and never a bare `java` from PATH.
    expect(GRADLE_JDK_CANDIDATES[0]).toContain('21');
    expect(GRADLE_JDK_CANDIDATES.some((p) => p.includes('25'))).toBe(false);
  });

  it('never exports CI', () => {
    // An empty CI makes `cargo tauri build` refuse to start ('a value is
    // required for --ci'), which broke `just remote-sync`; a truthy CI would
    // cap vitest to 4 workers and waste the box's 32 cores.
    const preamble = remoteEnvPreamble({ ndkVersion: '28.2.13676358' });
    expect(preamble).toContain('unset CI');
    expect(preamble).not.toMatch(/export CI=/);
  });

  it('pins ANDROID_NDK_HOME to the NDK gradle is pinned to, not "newest installed"', () => {
    // build.gradle.kts: a mismatch between ndkVersion and the NDK cargo-ndk
    // uses breaks NDK resolution and silently skips stripping.
    const pinned = ndkVersionFromGradle(gradle);
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(remoteEnvPreamble({ ndkVersion: pinned })).toContain(`ndk/${pinned}`);
  });

  it('rejects a gradle file with no ndkVersion rather than guessing', () => {
    expect(() => ndkVersionFromGradle('android { compileSdk = 36 }')).toThrow(/ndkVersion/);
  });

  it('creates the repo-root dist/ cargo needs (M20)', () => {
    expect(runScript()).toContain('mkdir -p dist');
  });
});

describe('run script', () => {
  it('propagates the recipe exit status instead of masking it (M11)', () => {
    const script = runScript();
    expect(script).toMatch(/just 'test-rust-full'\nSTATUS=\$\?/);
    expect(script.trimEnd().endsWith('exit $STATUS')).toBe(true);
    // Nothing may pipe the suite's output — a pipe reports the tail's status.
    expect(script).not.toMatch(/^just .*\|/m);
  });

  it('takes an exclusive lock on the remote worktree and releases it on any exit', () => {
    // Acquisition is phase 1 (its own ssh session, before any transfer);
    // release belongs to the run script that adopts it.
    expect(lockScript()).toContain('mkdir "$LOCK_DIR"');
    expect(lockScript()).toContain(`exit ${EXIT_LOCKED}`);
    expect(runScript()).toContain(`trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM HUP`);
  });

  it('shows a blocked run WHO holds the lock', () => {
    const script = lockScript();
    expect(script).toContain('if [ -f "$LOCK_DIR/holder" ]; then');
    // `2>/dev/null >&2` points fd1 at /dev/null (redirections apply left to
    // right) and silently ate the holder details the first time round.
    expect(script).not.toMatch(/2>\/dev\/null\s+>&2/);
  });

  it('fails a run whose checkout moved underneath it, instead of reporting the suite result', () => {
    // A concurrent main-health check that cd'd into the worktree by hand
    // produced 5 phantom test failures and two "Cannot find module" suites,
    // because HEAD moved mid-run. The lock cannot bind someone who bypasses
    // remote-test, so the sha is verified before AND after.
    const script = runScript();
    expect(script).toContain('HEAD_BEFORE="$(git rev-parse HEAD)"');
    expect(script).toContain('HEAD_AFTER="$(git rev-parse HEAD)"');
    expect(script).toContain('if [ "$HEAD_BEFORE" != "$HEAD_AFTER" ]; then');
    expect(script).toContain(`exit ${EXIT_MOVED}`);
    // ...and the void exit must not be confusable with the suite's own status.
    expect(EXIT_MOVED).not.toBe(EXIT_LOCKED);
    expect(EXIT_MOVED).not.toBe(EXIT_REFUSED);
  });

  it('git mode also verifies the checkout landed on the sha it asked for', () => {
    const script = runScript({ mode: 'git', sha: 'deadbeef1' });
    expect(script).toContain(`if [ "$HEAD_BEFORE" != 'deadbeef1' ]; then`);
  });

  it('keeps its pnpm stamp outside the checkout so it cannot dirty the tree', () => {
    const script = runScript();
    expect(script).toContain('STAMP_DIR="$HOME/.cache/futo-remote-test"');
    expect(script).not.toMatch(/STAMP="\.remote-test/);
    // and cleans up the old in-tree stamp it used to leave behind
    expect(script).toContain('rm -f .remote-test-pnpm-lock-hash');
  });

  it('fails fast by default and queues only when asked', () => {
    expect(lockScript()).toContain('WAIT_SECS=0');
    expect(lockScript({ waitSeconds: 600 })).toContain('WAIT_SECS=600');
    // The wait is a bounded loop around the atomic mkdir, not a sleep-then-hope.
    expect(lockScript({ waitSeconds: 600 })).toContain('while ! mkdir "$LOCK_DIR"');
  });

  it('only breaks the lock when explicitly asked', () => {
    expect(lockScript()).not.toContain('rm -rf "$LOCK_DIR"\nmkdir');
    expect(lockScript({ forceLock: true })).toContain('rm -rf "$LOCK_DIR"');
  });

  it('git mode fetches and detaches at the requested sha', () => {
    const script = runScript({ mode: 'git', sha: 'deadbeef1' });
    expect(script).toContain('git fetch --quiet origin');
    expect(script).toContain("checkout --force --detach 'deadbeef1'");
  });

  it('rsync mode never rewrites the checkout out from under the pushed tree', () => {
    const script = runScript({ mode: 'rsync' });
    expect(script).not.toContain('checkout --force --detach');
    expect(script).toContain('rsync mode');
  });

  it('creates the remote worktree on first use', () => {
    expect(runScript()).toContain('worktree add --detach');
  });

  it('shell-quotes recipe arguments', () => {
    const script = runScript({ recipe: 'test-rust', recipeArgs: ["it's; rm -rf /"] });
    expect(script).toContain(`just 'test-rust' 'it'\\''s; rm -rf /'`);
  });

  it('quotes single quotes so an argument cannot escape into the shell', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('doctor', () => {
  it('checks everything a suite here depends on', () => {
    const script = buildDoctorScript({
      remoteDir: '$HOME/ci/futo-main',
      sourceRepo: '$HOME/Developer/futo-notes',
      ndkVersion: '28.2.13676358',
    });
    for (const probe of [
      'node',
      'pnpm',
      'cargo',
      'cargo-ndk',
      'rust android targets',
      'pinned NDK',
      '/dev/kvm',
      'postgres container',
      'webkit2gtk-4.1',
      'playwright browsers',
      'android emulator',
    ]) {
      expect(script, `doctor does not probe ${probe}`).toContain(probe);
    }
  });

  it('parses CHECK rows and tolerates a pipe inside the detail', () => {
    const rows = parseDoctorOutput('noise\nCHECK|node|ok|v22 | nvm\nCHECK|pnpm|missing|\n');
    expect(rows).toEqual([
      { name: 'node', status: 'ok', detail: 'v22 | nvm' },
      { name: 'pnpm', status: 'missing', detail: '' },
    ]);
  });
});

describe('CLI', () => {
  it('defaults to the Tailscale host and git mode', () => {
    const opts = parseCliArgs(['check']);
    expect(opts).toMatchObject({ recipe: 'check', mode: 'git', user: DEFAULT_USER, host: null });
    expect(DEFAULT_HOST).toBe('jfedora');
  });

  it('accepts an explicit host/user and rsync mode', () => {
    const opts = parseCliArgs(['--rsync', '--host', 'other', '--user', 'ci', 'test-full']);
    expect(opts).toMatchObject({ mode: 'rsync', host: 'other', user: 'ci', recipe: 'test-full' });
  });

  it('passes recipe arguments through verbatim, flags included', () => {
    const opts = parseCliArgs(['test-cross-platform', '--scenario', 'five notes roundtrip']);
    expect(opts.recipe).toBe('test-cross-platform');
    expect(opts.recipeArgs).toEqual(['--scenario', 'five notes roundtrip']);
  });

  it('rejects an unknown option rather than forwarding it to just', () => {
    expect(() => parseCliArgs(['--nope', 'check'])).toThrow(/unknown option/);
  });

  it('reserves a distinct exit code for a refusal', () => {
    expect(EXIT_REFUSED).toBe(2);
    expect(EXIT_LOCKED).not.toBe(EXIT_REFUSED);
  });

  it('never rsyncs the heavyweight or machine-specific directories', () => {
    for (const excluded of ['node_modules', 'target', 'dist', '.git', 'test-screenshots']) {
      expect(RSYNC_EXCLUDES).toContain(excluded);
    }
  });
});

describe('justfile wiring', () => {
  it('exposes the portable suites as remote-* recipes', () => {
    for (const recipe of [
      'remote',
      'remote-doctor',
      'remote-check',
      'remote-rust',
      'remote-sync',
      'remote-android',
    ]) {
      expect(recipes.has(recipe), `just ${recipe} is missing`).toBe(true);
    }
  });

  it('routes every remote recipe through this script, so the deny-list cannot be skipped', () => {
    const remoteBlock = justfile
      .split('\n')
      .filter((line) => line.includes('remote-test.mjs'))
      .join('\n');
    for (const suite of ['check', 'test-rust-full', 'test-cross-platform']) {
      expect(remoteBlock).toContain(suite);
    }
    // No remote recipe may ssh on its own.
    expect(justfile).not.toMatch(/^\s+ssh .*just /m);
  });
});

// The rsync-mode corruption: rsync --delete used to push the working tree
// BEFORE the run script took the lock, so a run queued behind --wait deleted and
// rewrote the checkout the in-flight run was using. It cost two 300-doc runs,
// which degraded into 100+ failures that all read as product bugs
// (pc_7610adf57cbd, pc_48b854c9f90a, pc_ea83d57a69d5). The HEAD guard cannot
// see it: rsync mode never moves HEAD.
describe('two-phase lock (rsync cannot precede the lock)', () => {
  it('acquires the lock in a script that does no transfer and runs no recipe', () => {
    const script = lockScript();
    expect(script).toContain('mkdir "$LOCK_DIR"');
    expect(script).not.toContain('rsync');
    expect(script).not.toContain('just ');
  });

  it('records a nonce so a later phase can prove the lock is still ours', () => {
    expect(lockScript()).toContain('"$LOCK_DIR/nonce"');
    expect(lockScript({ nonce: 'abc-123' })).toContain('abc-123');
  });

  it('makes the run script ADOPT the lock — it can never acquire one itself', () => {
    const script = runScript();
    // No acquisition primitives left in the run script at all.
    expect(script).not.toContain('while ! mkdir "$LOCK_DIR"');
    expect(script).not.toContain('WAIT_SECS');
    // It verifies the lock is still the one phase 1 took...
    expect(script).toContain('LOCK_NONCE="test-nonce-0001"');
    expect(script).toContain(`exit ${EXIT_LOCKED}`);
    // ...and owns the release.
    expect(script).toContain(`trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM HUP`);
  });

  it('releases the lock only when the nonce still matches', () => {
    const script = buildUnlockScript({ remoteDir: '$HOME/ci/futo-main', nonce: 'abc-123' });
    expect(script).toContain('abc-123');
    expect(script).toContain('rm -rf "$LOCK_DIR"');
  });

  it('marks the holder as being in the transfer phase', () => {
    // A lock stranded between phases is identifiable as stale rather than
    // looking like a live run.
    expect(lockScript({ holder: 'who=justin@mac\nphase=transfer' })).toContain('phase=transfer');
  });
});
