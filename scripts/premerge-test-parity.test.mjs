import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');
const gitlabPipeline = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8');
const packageScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const cirrusTasks = readFileSync(join(ROOT, '.cirrus.yml'), 'utf8');
const androidInstrumentationScript = readFileSync(
  join(ROOT, 'scripts/ci-android-instrumentation.sh'),
  'utf8',
);
const androidEmulatorScript = readFileSync(join(ROOT, 'scripts/ci-android-emulator.sh'), 'utf8');
const androidSyncLegScript = readFileSync(join(ROOT, 'scripts/ci-android-sync-leg.sh'), 'utf8');
const prePushHook = readFileSync(join(ROOT, '.githooks/pre-push'), 'utf8');
const iosStoryAvailabilityGate = readFileSync(
  join(ROOT, 'scripts/run-ios-stories-if-available.sh'),
  'utf8',
);

function topLevelBlock(contents, startPattern) {
  const match = startPattern.exec(contents);
  if (match?.index == null) throw new Error(`Missing operational entry point: ${startPattern}`);

  const blockStart = match.index;
  const remainingContents = contents.slice(blockStart + match[0].length);
  const nextBlockOffset = remainingContents.search(/^\S[^\n]*:\s*(?:#.*)?$/m);

  return nextBlockOffset === -1
    ? contents.slice(blockStart)
    : contents.slice(blockStart, blockStart + match[0].length + nextBlockOffset);
}

describe('pre-merge CI routing contracts', () => {
  it('builds iOS stories from the pushed source and routes them through both local gates', () => {
    const storyRecipe = topLevelBlock(justfile, /^test-ios-stories:[^\n]*$/m);
    const prepushRecipe = topLevelBlock(justfile, /^prepush:[^\n]*$/m);

    expect(storyRecipe).toContain('just ios-native');
    expect(storyRecipe).toContain('node tests/ios-editor-stories.mjs');
    expect(storyRecipe.indexOf('just ios-native')).toBeLessThan(
      storyRecipe.indexOf('node tests/ios-editor-stories.mjs'),
    );
    expect(prepushRecipe).toContain('scripts/run-ios-stories-if-available.sh');
    expect(prePushHook).toContain('scripts/run-ios-stories-if-available.sh');
    expect(prePushHook).toContain('apps/ios/');
    expect(prePushHook).toContain('packages/editor/');
    expect(prePushHook).toContain('crates/futo-notes-(core|store|ffi)/');
    expect(iosStoryAvailabilityGate).toContain('FUTO_SKIP_IOS_STORIES');
    expect(iosStoryAvailabilityGate).toContain('AXE_BIN');
    expect(iosStoryAvailabilityGate).toContain('just qa-claim ios');
    expect(iosStoryAvailabilityGate).toContain('iOS DEVICE STORIES SKIPPED');
  });

  it('does not repeat P0 smoke coverage in the remaining Playwright suite', () => {
    expect(packageScripts['test:e2e:rest']).toContain('P0 Crash and IME Regressions');
  });

  it('uses bounded Playwright concurrency without multiplying CI jobs', () => {
    const restJob = topLevelBlock(gitlabPipeline, /^test:e2e:rest:$/m);

    // The markdown-spec corpus runs inside test:e2e:rest (its former
    // standalone job was merged in to stop paying a third dev-server +
    // browser-install setup); the rest suite must not filter it back out
    // and must re-run when the corpus changes.
    expect(gitlabPipeline).not.toMatch(/^test:e2e:markdown-spec:$/m);
    expect(packageScripts['test:e2e:rest']).not.toContain('Markdown Spec');
    expect(restJob).toContain('- markdown-spec/**/*');
    expect(restJob).toContain('pnpm run test:e2e:rest');
    expect(packageScripts['test:e2e:rest']).toContain('--workers=2');
    expect(restJob).not.toContain('parallel: 2');
    expect(restJob).not.toContain('--shard=');
  });

  it('does not recompress the shared Rust target cache after source-only MR jobs', () => {
    const rustWorkspaceJob = topLevelBlock(gitlabPipeline, /^test:rust:workspace:$/m);
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(rustWorkspaceJob).toContain('CARGO_CACHE_POLICY: pull');
    expect(rustWorkspaceJob).toContain('- dind_fast');
    expect(rustWorkspaceJob).toContain('needs: []');
    expect(syncJob).toMatch(/^\s{4}CARGO_CACHE_POLICY: pull$/m);
    expect(syncJob).toContain('CARGO_CACHE_POLICY: pull-push');
    expect(syncJob).toContain('.cache-cargo-sync');
    expect(syncJob).toContain('needs: []');
    expect(rustWorkspaceJob).toContain('Cargo.lock');
    expect(rustWorkspaceJob).toContain('CARGO_CACHE_POLICY: pull-push');
  });

  it('does not cancel manual image rebuilds when a newer pipeline starts', () => {
    const androidImageJob = topLevelBlock(gitlabPipeline, /^build:ci-android-image:$/m);
    const testImageJob = topLevelBlock(gitlabPipeline, /^build:ci-test-image:$/m);

    expect(androidImageJob).toContain('interruptible: false');
    expect(testImageJob).toContain('interruptible: false');
  });

  it('runs Android instrumentation tests in the required native build job', () => {
    const androidJob = topLevelBlock(gitlabPipeline, /^build:android-native:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);

    expect(androidJob).toContain('bash "$CI_PROJECT_DIR/scripts/ci-android-instrumentation.sh"');
    expect(androidJob).toContain(
      'apps/android/app/build/outputs/androidTest-results/connected/debug/TEST-*.xml',
    );
    expect(androidJob).toContain('- scripts/ci-android-instrumentation.sh');
    expect(androidJob).not.toContain('- docs/**/*');
    expect(androidJob).not.toContain('- .gitlab-ci.yml');
    expect(releaseGate).toContain('- job: build:android-native');
    // Device readiness now lives in the shared emulator script (both CI
    // emulator users source it), so assert the wiring plus the wait itself.
    expect(androidInstrumentationScript).toContain('scripts/ci-android-emulator.sh');
    expect(androidInstrumentationScript).toContain('ci_emulator_start --wipe');
    expect(androidEmulatorScript).toContain('sys.boot_completed');
    expect(androidInstrumentationScript).toContain(':app:connectedDebugAndroidTest');
    expect(androidInstrumentationScript).toContain(
      'Android instrumentation results contain no testcases',
    );
  });

  it('runs the desktop<->Android sync leg on a booted emulator and gates the release on it', () => {
    const androidSyncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:android:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);

    expect(androidSyncJob).toContain('bash "$CI_PROJECT_DIR/scripts/ci-android-sync-leg.sh"');
    expect(androidSyncJob).toContain('- job: build:android-native');
    // Same runner-exclusion as the desktop mesh; overlapping starves both.
    expect(androidSyncJob).toContain('resource_group: cross-platform-sync');
    expect(releaseGate).toContain('- job: test:cross-platform-sync:android');
    // The APK producer's gate must be a superset of this job's, so neither may
    // trigger on a path the other ignores (build:android-native excludes
    // .gitlab-ci.yml and docs, per the test above).
    expect(androidSyncJob).not.toContain('- .gitlab-ci.yml');
    expect(androidSyncJob).not.toContain('- docs/**/*');
    // A run that finds no usable device must fail, not report green (M11).
    expect(androidSyncLegScript).toContain('--android-only');
    expect(androidEmulatorScript).toContain('service check package');
  });

  it('keeps mobile-target Rust compile coverage on every crate change', () => {
    // The full native builds are scoped to shell/FFI changes, so these checks
    // are what proves an inner-crate change still compiles for mobile targets.
    const androidCheckJob = topLevelBlock(gitlabPipeline, /^test:rust:ffi-android:$/m);
    const macosRustJob = topLevelBlock(gitlabPipeline, /^test:rust:macos:$/m);
    const macosRustTask = topLevelBlock(cirrusTasks, /^test_rust_macos_task:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);

    expect(androidCheckJob).toContain('- crates/**/*');
    expect(androidCheckJob).toContain('build -p futo-notes-ffi --profile release-ffi');
    // Serialized against the sync suite on the shared pinned runner — a
    // concurrent full-tree compile flakes its timing-sensitive scenarios —
    // and ordered after it, so the exclusion never delays the sync suite.
    expect(androidCheckJob).toContain('resource_group: cross-platform-sync');
    expect(androidCheckJob).toContain('job: test:cross-platform-sync');
    expect(macosRustJob).toContain('- crates/**/*');
    expect(macosRustTask).toContain('cargo check -p futo-notes-ffi --target aarch64-apple-ios');
    expect(releaseGate).toContain('- job: test:rust:ffi-android');
  });

  it('runs full macOS workspace tests on main and tags but not MR pipelines', () => {
    const macosRustJob = topLevelBlock(gitlabPipeline, /^test:rust:macos:$/m);
    const macosRustTask = topLevelBlock(cirrusTasks, /^test_rust_macos_task:$/m);

    // MRs get only the iOS compile check (the workspace suite is the hard
    // Linux gate); the Cirrus task keys the full run off tag/default-branch.
    expect(macosRustTask).toContain('cargo test --workspace');
    expect(macosRustTask).toContain('"${CI_COMMIT_BRANCH:-}" = "${CI_DEFAULT_BRANCH}"');
    expect(macosRustJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  it('keeps MR iOS coverage in one Mac job after dropping build:ios-native from MRs', () => {
    const iosBuildJob = topLevelBlock(gitlabPipeline, /^build:ios-native:$/m);
    const iosTestJob = topLevelBlock(gitlabPipeline, /^test:ios-native:$/m);
    const smokeJob = topLevelBlock(gitlabPipeline, /^test:desktop-smoke:macos:$/m);

    // build:ios-native is main+tag only; test:ios-native carries its former
    // MR paths so an FFI change still gets an iOS build (plus tests) on MRs.
    expect(iosBuildJob).not.toContain('$CI_MERGE_REQUEST_IID');
    expect(iosTestJob).toContain('- crates/futo-notes-ffi/**/*');
    expect(iosTestJob).toContain('- Cargo.lock');
    // Desktop smoke auto-runs on main pushes, manual-only on MRs.
    expect(smokeJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(smokeJob).not.toMatch(/\$CI_MERGE_REQUEST_IID\n {6}changes:/);
  });

  it('publishes stores and package repos only from stable tags', () => {
    const stableTag = 'if: $CI_COMMIT_TAG =~ /^v[0-9]+\\.[0-9]+\\.[0-9]+$/';
    for (const jobName of [
      /^publish:ios:$/m,
      /^publish:android:$/m,
      /^release:$/m,
      /^update-fdroid:$/m,
      /^pkg-futoinfra:prep:$/m,
      /^pkg-futoinfra:trigger:$/m,
    ]) {
      expect(topLevelBlock(gitlabPipeline, jobName)).toContain(stableTag);
    }
  });

  it('keeps iOS tests required for iOS changes while exposing an optional MR run', () => {
    const iosTestJob = topLevelBlock(gitlabPipeline, /^test:ios-native:$/m);

    expect(iosTestJob).toContain('changes: &native-ios-test-changes');
    expect(iosTestJob).toMatch(
      /- \.gitlab-ci\.yml\n    - if: \$CI_MERGE_REQUEST_IID\n      when: manual\n      allow_failure: true/,
    );
    expect(iosTestJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(iosTestJob).toContain('$CI_COMMIT_TAG');
  });

  it('skips slow sync scenarios only on MR pipelines, never on main or tags', () => {
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(syncJob).toContain('node tests/cross-platform-sync.mjs $SYNC_SCENARIO_FLAGS');
    // Exactly the two auto-run MR rules (lockfile, sync-critical) set the
    // flag; the tag, default-branch, and manual rules run the full set.
    expect(syncJob.match(/SYNC_SCENARIO_FLAGS: --skip-slow/g)).toHaveLength(2);
    expect(syncJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  it('limits the pre-baked image to jobs that benefit from it', () => {
    const defaultBlock = topLevelBlock(gitlabPipeline, /^default:$/m);
    const testImageBlock = topLevelBlock(gitlabPipeline, /^\.ci-test-image:$/m);
    const rustWorkspaceJob = topLevelBlock(gitlabPipeline, /^test:rust:workspace:$/m);
    const syncJob = topLevelBlock(gitlabPipeline, /^test:cross-platform-sync:$/m);

    expect(defaultBlock).toMatch(/^\s+image: .*\/kitchensink@sha256:[a-f0-9]{64}$/m);
    expect(testImageBlock).toMatch(/^\s+name: .*\/ci\/test@sha256:[a-f0-9]{64}$/m);
    expect(testImageBlock).toContain('pull_policy: if-not-present');
    expect(rustWorkspaceJob).toContain('extends: .ci-test-image');
    expect(syncJob).toContain('extends: .ci-test-image');
  });

  // Both of these fail far from the change: a broken COPY surfaces only when
  // someone runs the manual image rebuild, with `just check` silent until then.
  it('keeps the baked-Node images buildable', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    for (const file of ['ci/test.Dockerfile', 'ci/android.Dockerfile']) {
      const dockerfile = readFileSync(join(ROOT, file), 'utf8');
      expect(dockerfile).toContain('COPY .nvmrc');
      expect(dockerfile).toContain('COPY ci/install-fnm.sh');
      // Baking is what makes every job's `fnm use` an offline no-op. Matched as
      // a command, since the surrounding comment also names it.
      expect(dockerfile).toMatch(/^\s+cd \/tmp && fnm install /m);
      // A job that never calls `fnm use` must still get .nvmrc's Node, not the
      // base image's default.
      expect(dockerfile).toMatch(/^ENV PATH=\$FNM_DIR\/aliases\/default\/bin:/m);
    }
    // .dockerignore denies everything by default, so both COPY sources resolve
    // only because they are re-included. `!ci/` with a trailing slash does NOT
    // match the directory — it silently drops the file and the image build dies
    // with "not found", so assert the exact forms that work.
    expect(dockerignore).toMatch(/^!\.nvmrc$/m);
    expect(dockerignore).toMatch(/^!ci$/m);
    expect(dockerignore).toMatch(/^!ci\/install-fnm\.sh$/m);
  });

  // .nvmrc holds the exact patch and every surface activates it through fnm.
  // Before fnm there were three capability tiers — nodesource and Homebrew could
  // express only a major line, and Windows pinned against a moving LTS pointer —
  // so "the pinned version" meant something different on each OS.
  it('activates every Node through fnm from .nvmrc', () => {
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
    const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines;
    expect(engines.node).toContain(nvmrc);
    // fnm resolves engines.node when no .nvmrc exists (FNM_RESOLVE_ENGINES is on
    // by default), and it resolves a RANGE — so a bound-less `>=22` would let
    // --install-if-missing quietly fetch a newer major. Keep the upper bound.
    expect(engines.node).toMatch(/<\s*\d+/);

    // `fnm use` is both the pin and the verification: it exits non-zero rather
    // than falling back to another Node. Matched as a script line, because the
    // neighbouring comments name the command too.
    const activates = /^\s+- fnm use --install-if-missing$/m;
    expect(topLevelBlock(gitlabPipeline, /^default:$/m)).toMatch(activates);

    // No surface may return to a major-only installer, which cannot honour the
    // patch in .nvmrc — that inability is why each of these was replaced.
    expect(cirrusTasks).not.toMatch(/node@\d/);
    expect(cirrusTasks).not.toContain('NODE_MAJOR');
    expect(gitlabPipeline).not.toMatch(/setup_\d+\.x/);
    expect(gitlabPipeline).not.toContain('NODE_MAJOR');
    expect(gitlabPipeline).not.toContain('nvm install');

    // Relational, not a magic count: every macOS task that installs fnm must
    // also activate it, so adding a task cannot drift and cannot break this for
    // no reason.
    const brews = cirrusTasks.match(/brew install fnm/g) ?? [];
    const activations = cirrusTasks.match(/fnm use --install-if-missing/g) ?? [];
    expect(brews.length).toBeGreaterThan(0);
    expect(activations).toHaveLength(brews.length);

    // The pairing above only counts tasks that DID install fnm, and the node@NN
    // check only catches a versioned formula — so a new task written
    // `brew install node` would satisfy every assertion while running an
    // unpinned Node, which is the exact drift this test exists to stop. Bind it
    // to the thing every such task needs instead: corepack.
    expect(cirrusTasks).not.toMatch(/brew install [^\n]*\bnode\b/);
    const cirrusScriptBlocks = cirrusTasks.split(/^ {2}[\w]+_script:$/m).slice(1);
    expect(cirrusScriptBlocks.length).toBeGreaterThan(0);
    for (const block of cirrusScriptBlocks) {
      if (!block.includes('corepack enable')) continue;
      expect(block).toContain('fnm use --install-if-missing');
    }

    // fnm itself is bootstrapped, never assumed. The shared base image is another
    // team's and has no fnm, and our own images only gain it on a manual rebuild,
    // so a surface that activates fnm without installing it first dies on
    // `fnm: command not found` (exit 127). Note `eval "$(fnm env)"` does NOT
    // catch this: eval of an empty string succeeds, so the failure lands one
    // line later.
    const installer = 'sh "$CI_PROJECT_DIR/ci/install-fnm.sh"';
    expect(topLevelBlock(gitlabPipeline, /^default:$/m)).toContain(installer);
    // `test:` gates every MR, so it must never be the job running whatever Node
    // the image happens to default to. It gets the pin by INHERITING the
    // `default:` block asserted above, which is only true while it declares no
    // before_script of its own — so that absence IS the guard, and it also
    // catches the `before_script: []` that would opt out silently. Should the
    // job ever need its own block again, that block has to bootstrap and
    // activate fnm itself.
    const testJob = topLevelBlock(gitlabPipeline, /^test:$/m);
    if (/^\s+before_script:/m.test(testJob)) {
      expect(testJob).toContain(installer);
      expect(testJob).toMatch(activates);
    }
    // Asserted directly, not just via the count below: build:linux-packages and
    // build:linux-appimage both use this anchor and both hold the updater key, and
    // deleting BOTH of its lines keeps the bootstrap/activation counts equal.
    const linuxAnchor = /before_script: &linux-before-script\n([\s\S]*?)\n  cache:/.exec(
      gitlabPipeline,
    )?.[1];
    expect(linuxAnchor).toBeTruthy();
    expect(linuxAnchor).toContain(installer);
    expect(linuxAnchor).toContain('fnm use --install-if-missing');

    const gitlabActivations = gitlabPipeline.match(/fnm use --install-if-missing/g) ?? [];
    const bootstraps = gitlabPipeline.match(/sh "\$CI_PROJECT_DIR\/ci\/install-fnm\.sh"/g) ?? [];
    expect(gitlabActivations.length).toBeGreaterThan(0);
    expect(bootstraps).toHaveLength(gitlabActivations.length);

    // One place for the pinned release, checksummed rather than piped into a
    // shell — the Linux release jobs that call it hold the updater key.
    const installScript = readFileSync(join(ROOT, 'ci/install-fnm.sh'), 'utf8');
    expect(installScript).toMatch(/^FNM_VERSION=v\d+\.\d+\.\d+$/m);
    // Anchored: `| sha256sum -c - || true` still contains the substring, on the
    // path whose whole justification is that its callers hold the updater key.
    expect(installScript).toMatch(/^echo "\$sha  \$tmp\/fnm\.zip" \| sha256sum -c -$/m);
    // A transient GitHub failure must not fail the job that gates every MR.
    expect(installScript).toContain('--retry');
    // Both architectures: a hardcoded x86-64 asset fails an arm64 build with a
    // bare `exit code: 133` and no diagnostic.
    expect(installScript).toMatch(/^FNM_SHA256_X86_64=[0-9a-f]{64}$/m);
    expect(installScript).toMatch(/^FNM_SHA256_AARCH64=[0-9a-f]{64}$/m);
    // And nowhere else, which is why this pin needs no drift-registry entry.
    expect(gitlabPipeline).not.toContain('fnm-linux.zip');
    for (const file of ['ci/test.Dockerfile', 'ci/android.Dockerfile']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toContain('fnm-linux.zip');
    }

    // Windows splits tool from version: win-install-deps.ps1 is scp'd to the VM
    // alone and runs BEFORE the clone, so .nvmrc does not exist there yet.
    // Resolving a version in that script reads a path that does not exist and
    // kills build:windows — invisible on MRs, where the job is manual and
    // allow_failure, and fatal at tag time when windows:sign never runs.
    const winDeps = readFileSync(join(ROOT, 'ci/win-install-deps.ps1'), 'utf8');
    const winBuild = readFileSync(join(ROOT, 'ci/win-build.ps1'), 'utf8');
    expect(winDeps).toContain('Schniz.fnm');
    expect(winDeps).not.toContain('OpenJS.NodeJS');
    expect(winDeps).not.toContain('NodeVersion');
    expect(winDeps).not.toContain('Join-Path $PSScriptRoot');
    expect(gitlabPipeline).not.toContain('-NodeVersion');

    // The version is resolved after the clone, and asserted after activation —
    // this VM produces the binary that gets Authenticode signed.
    const clonedAt = winBuild.indexOf('Set-Location C:\\build\\futo-notes');
    const activatedAt = winBuild.indexOf('fnm use --install-if-missing');
    const usesNodeAt = winBuild.indexOf('node scripts\\desktop-version.mjs');
    expect(clonedAt).toBeGreaterThan(-1);
    expect(activatedAt).toBeGreaterThan(clonedAt);
    expect(usesNodeAt).toBeGreaterThan(activatedAt);
    // The abort keyword, not its message: turning `throw` into `Write-Warning`
    // keeps the sentence and drops the guarantee.
    expect(winBuild).toMatch(/throw "Node \$expectedNode is pinned/);

    // windows:sign is the ONE sanctioned exception: Node there only runs the
    // pinned @tauri-apps/cli, which is what actually determines the updater
    // signature, and that job holds the signing key (M23). Exactly one such
    // installer may exist, so a second one cannot arrive unnoticed.
    const distroNode = gitlabPipeline.match(/apt-get install -y[^\n]*\bnodejs\b[^\n]*/g) ?? [];
    expect(distroNode).toHaveLength(1);
    expect(gitlabPipeline).toMatch(/npx --yes @tauri-apps\/cli@\d+\.\d+\.\d+ signer sign/);
  });
});
