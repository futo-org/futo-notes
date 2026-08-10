import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CAVEATED,
  DEFAULT_HOST,
  DEFAULT_USER,
  EXIT_LOCKED,
  EXIT_REFUSED,
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

function runScript(overrides = {}) {
  return buildRunScript({
    remoteDir: '$HOME/ci/futo-main',
    sourceRepo: '$HOME/Developer/futo-notes',
    mode: 'git',
    sha: 'abc1234def',
    recipe: 'test-rust-full',
    recipeArgs: [],
    holder: 'who=justin@mac',
    forceLock: false,
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

  it('warns that cross-platform sync shares one box-global Postgres', () => {
    expect(classify('test-cross-platform').caveats.join(' ')).toMatch(/per-worktree isolation/);
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
    expect(preamble).toContain(`export CARGO_TARGET_DIR="${REMOTE_CARGO_TARGET_DIR}"`);
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
    const script = runScript();
    expect(script).toContain('mkdir "$LOCK_DIR"');
    expect(script).toContain(`exit ${EXIT_LOCKED}`);
    expect(script).toContain(`trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM HUP`);
  });

  it('only breaks the lock when explicitly asked', () => {
    expect(runScript()).not.toContain('rm -rf "$LOCK_DIR"\nmkdir');
    expect(runScript({ forceLock: true })).toContain('rm -rf "$LOCK_DIR"');
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
