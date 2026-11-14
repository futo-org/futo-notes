import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ROOT,
  justfile,
  gitlabPipeline,
  cirrusTasks,
  androidInstrumentationScript,
  androidEmulatorScript,
  androidRunScript,
  fdroidIndexScript,
  iosStoryAvailabilityGate,
  topLevelBlock,
} from './premerge-test-parity.helpers.mjs';

describe('pre-merge CI routing contracts: native mobile jobs', () => {
  it('builds iOS stories from the pushed source and routes them through just prepush', () => {
    const storyRecipe = topLevelBlock(justfile, /^test-ios-stories:[^\n]*$/m);
    const prepushRecipe = topLevelBlock(justfile, /^prepush:[^\n]*$/m);

    expect(storyRecipe).toContain('just test-ios-native-ui');
    expect(storyRecipe).toContain('TextFirstLeaveUITests');
    expect(storyRecipe).toContain('TextFirstSelectionUITests');
    expect(prepushRecipe).toContain('scripts/run-ios-stories-if-available.sh');
    expect(iosStoryAvailabilityGate).toContain('FUTO_SKIP_IOS_STORIES');
    expect(iosStoryAvailabilityGate).not.toContain('AXE_BIN');
    expect(iosStoryAvailabilityGate).toContain('just qa-claim ios');
    expect(iosStoryAvailabilityGate).toContain('iOS DEVICE STORIES SKIPPED');
  });

  it('builds only the simulator slice in the iOS test job', () => {
    const iosTestTask = topLevelBlock(cirrusTasks, /^test_ios_native_task:$/m);
    const buildScript = readFileSync(join(ROOT, 'scripts/build-rust-ios.sh'), 'utf8');

    // Simulator slice only in the test task; the shared script keeps three triples by default.
    expect(iosTestTask).toContain('FUTO_IOS_SIM_ARM64_ONLY=1 bash scripts/build-rust-ios.sh');
    expect(buildScript).toContain('--target aarch64-apple-ios --profile');
    expect(buildScript).toContain('--target x86_64-apple-ios --profile');
  });

  it('runs Android instrumentation tests in the required native build job', () => {
    const androidJob = topLevelBlock(gitlabPipeline, /^build:android-native:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);

    expect(androidJob).toContain('bash "$CI_PROJECT_DIR/scripts/ci-android-instrumentation.sh"');
    expect(androidJob).toContain(
      'apps/android/app/build/outputs/androidTest-results/connected/**/TEST-*.xml',
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
    expect(androidInstrumentationScript).toContain(':app:connectedDirectDebugAndroidTest');
    expect(androidInstrumentationScript).toContain(
      'Android instrumentation results contain no testcases',
    );
  });

  it('builds both Android distribution flavors and routes each to its own consumer', () => {
    // Product flavors renamed every Gradle variant task AND every output path
    // under app/build/outputs (`apk/debug` → `apk/direct/debug`, `bundle/release`
    // → `bundle/playRelease`). A missed caller does not fail loudly — it finds
    // nothing and the artifact silently stops existing, which is exactly the
    // artifact-path-drift class the release gate exists to catch. These are the
    // consumers, each pinned to the flavor it is allowed to ship.
    const androidJob = topLevelBlock(gitlabPipeline, /^build:android-native:$/m);
    const releaseGate = topLevelBlock(gitlabPipeline, /^release:gate:$/m);
    const publishAndroidJob = topLevelBlock(gitlabPipeline, /^publish:android:$/m);
    const releaseJob = topLevelBlock(gitlabPipeline, /^release:$/m);
    const deployRecipe = topLevelBlock(justfile, /^deploy-android[^\n]*:[^\n]*$/m);
    const buildRecipe = topLevelBlock(justfile, /^build-android-native:[^\n]*$/m);
    const unitTestRecipe = topLevelBlock(justfile, /^test-android-native(?=\s|:)[^\n]*$/m);
    const uiTestRecipe = topLevelBlock(justfile, /^test-android-native-ui(?=\s|:)[^\n]*$/m);

    // Mobile runs the Rust editor directly; a web bundle cannot be its test subject.
    for (const recipe of [unitTestRecipe, uiTestRecipe]) {
      expect(recipe).not.toContain('vite.editor.config.ts');
    }

    // Compile coverage: a flavor-specific source set that fails to build must
    // fail the pipeline, so both flavors are assembled on every path.
    expect(androidJob).toContain(':app:assembleDirectDebug :app:assemblePlayDebug');
    expect(androidJob).toContain(':app:assembleDirectRelease :app:bundlePlayRelease');
    // Both flavors' unit tests run: DistributionFlavorTest is only a lock if
    // it is evaluated once with IS_PLAY_BUILD false and once with it true.
    expect(androidJob).toContain(':app:testDirectDebugUnitTest :app:testPlayDebugUnitTest');
    expect(androidJob).toContain(
      'apps/android/app/build/test-results/testDirectDebugUnitTest/**/TEST-*.xml',
    );
    expect(androidJob).toContain(
      'apps/android/app/build/test-results/testPlayDebugUnitTest/**/TEST-*.xml',
    );

    // direct = GitLab release / Obtainium / F-Droid. play = Google Play only.
    expect(releaseGate).toContain('apps/android/app/build/outputs/apk/direct/release');
    expect(releaseGate).toContain('apps/android/app/build/outputs/bundle/playRelease');
    expect(publishAndroidJob).toContain('apps/android/app/build/outputs/bundle/playRelease');
    expect(publishAndroidJob).not.toContain('outputs/bundle/release');
    expect(releaseJob).toContain('apps/android/app/build/outputs/apk/direct/release');
    expect(fdroidIndexScript).toContain('apps/android/app/build/outputs/apk/direct/release/*.apk');

    // Local recipes follow the same split, and the dev loop stays on direct.
    expect(buildRecipe).toContain(':app:assembleDirectDebug :app:assemblePlayDebug');
    expect(unitTestRecipe).toContain(':app:testDirectDebugUnitTest :app:testPlayDebugUnitTest');
    expect(uiTestRecipe).toContain(':app:connectedDirectDebugAndroidTest');
    // deploy-android takes the flavor as an argument and DEFAULTS to direct, so
    // a bare `just deploy-android` still installs the sideload build.
    expect(justfile).toContain('deploy-android flavor="direct":');
    expect(deployRecipe).toContain(':app:assemble${VARIANT}Release');
    expect(deployRecipe).toContain('app/build/outputs/apk/{{flavor}}/release');
    expect(androidRunScript).toContain('FUTO_ANDROID_FLAVOR');
    expect(androidRunScript).toMatch(/FUTO_ANDROID_FLAVOR:-direct/);
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
    expect(androidCheckJob).toContain('    - $LINUX_RUNNER_TAG');
    expect(androidCheckJob).not.toContain('resource_group');
    expect(macosRustTask).toContain('cargo check -p futo-notes-ffi --target aarch64-apple-ios');
    expect(releaseGate).toContain('- job: test:rust:ffi-android');
  });

  // RC-21 / L1-005: editor.html is built from vite.editor.config.ts and shipped
  // to both native shells, and the bridge specs / Swift bridge tests run against
  // it. An MR touching only a file in that import graph used to drop these jobs
  // to manual+allow_failure. The graph was derived from a real build (rollup
  // getModuleIds over vite.editor.config.ts); the globs below are its directories.
});

it.each([
  ['', 0, 1],
  ['Executed 0 tests, with 0 failures', 0, 1],
  ['Executed 1 test, with 0 failures', 0, 0],
  ['Test run with 12 tests in 2 suites passed', 0, 0],
  ['Executed 1 test, with 1 failure', 65, 65],
])('rejects empty iOS test runs: %s (xcode exit %s)', (output, code, expected) => {
  const recipe = topLevelBlock(justfile, /^_test-ios [^\n]*$/m);
  const command = recipe.slice(recipe.indexOf('  xcodebuild test')).replace(/^  /gm, '');
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    set -euo pipefail
    ONLY_TESTING=(); SIM=fixture
    xcodebuild() { printf '%s\\n' "$TEST_OUTPUT"; return "$TEST_EXIT"; }
    ${command}
  `,
    ],
    { encoding: 'utf8', env: { ...process.env, TEST_OUTPUT: output, TEST_EXIT: String(code) } },
  );
  expect(result.status, result.stderr).toBe(expected);
  expect(result.stdout).toContain(output);
});
