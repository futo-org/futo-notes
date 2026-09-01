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
});
