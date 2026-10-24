import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ROOT,
  justfile,
  gitlabPipeline,
  cirrusTasks,
  androidInstrumentationScript,
  androidEmulatorScript,
  androidSyncLegScript,
  androidRunScript,
  fdroidIndexScript,
  iosStoryAvailabilityGate,
  topLevelBlock,
} from './premerge-test-parity.helpers.mjs';

describe('pre-merge CI routing contracts: native mobile jobs', () => {
  it('builds iOS stories from the pushed source and routes them through just prepush', () => {
    const storyRecipe = topLevelBlock(justfile, /^test-ios-stories:[^\n]*$/m);
    const prepushRecipe = topLevelBlock(justfile, /^prepush:[^\n]*$/m);

    expect(storyRecipe).toContain('just ios-native');
    expect(storyRecipe).toContain('node tests/ios-editor-stories.mjs');
    expect(storyRecipe.indexOf('just ios-native')).toBeLessThan(
      storyRecipe.indexOf('node tests/ios-editor-stories.mjs'),
    );
    expect(prepushRecipe).toContain('scripts/run-ios-stories-if-available.sh');
    expect(iosStoryAvailabilityGate).toContain('FUTO_SKIP_IOS_STORIES');
    expect(iosStoryAvailabilityGate).toContain('AXE_BIN');
    expect(iosStoryAvailabilityGate).toContain('just qa-claim ios');
    expect(iosStoryAvailabilityGate).toContain('iOS DEVICE STORIES SKIPPED');
  });

  it('runs the same iOS unit bundle locally as CI runs on merge requests', () => {
    // `just test-ios-native` once ran the UI bundle too: minutes of XCUITest per
    // run for ~12s of unit tests, while the MR tier ran only the unit bundle.
    const unitRecipe = topLevelBlock(justfile, /^test-ios-native(?=\s|:)[^\n]*$/m);
    const iosTestTask = topLevelBlock(cirrusTasks, /^test_ios_native_task:$/m);
    expect(unitRecipe).toContain('just _test-ios FutoNotesNativeTests');
    expect(justfile).toContain('ONLY_TESTING=("-only-testing:$BUNDLE")');
    expect(iosTestTask).toContain('ONLY_TESTING=(-only-testing:FutoNotesNativeTests)');
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
    const uiTestRecipe = topLevelBlock(justfile, /^test-android-native-ui:[^\n]*$/m);

    // L1-008: the Android test recipes must test the editor.html of the checkout,
    // not whatever gitignored copy an earlier build left in the assets.
    for (const recipe of [unitTestRecipe, uiTestRecipe]) {
      expect(recipe).toContain('vite build --config vite.editor.config.ts');
      expect(recipe.indexOf('vite build --config vite.editor.config.ts')).toBeLessThan(
        recipe.indexOf('./gradlew'),
      );
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
    expect(androidSyncLegScript).toContain(
      'apps/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk',
    );

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
    // Serialized against the sync suite on the shared pinned runner — a
    // concurrent full-tree compile flakes its timing-sensitive scenarios —
    // and ordered after it, so the exclusion never delays the sync suite.
    expect(androidCheckJob).toContain('resource_group: cross-platform-sync');
    expect(androidCheckJob).toContain('job: test:cross-platform-sync');
    expect(macosRustTask).toContain('cargo check -p futo-notes-ffi --target aarch64-apple-ios');
    expect(releaseGate).toContain('- job: test:rust:ffi-android');
  });

  it('starts an iOS-target compile check on MRs for every crate', () => {
    // test:rust:macos's MR run type-checks futo-notes-ffi's whole dependency
    // tree for aarch64-apple-ios; test:ios-native builds futo-notes-ffi for all
    // three iOS triples. The macOS list names crates one by one (the FFI crate
    // belongs to test:ios-native alone), so a new crate must be added to one of
    // them or an MR touching only it gets no iOS compile until main.
    const mrChanges = (jobPattern) => {
      const job = topLevelBlock(gitlabPipeline, jobPattern);
      const mrRule = job.slice(job.indexOf('- if: $CI_MERGE_REQUEST_IID\n      changes:'));
      return mrRule.slice(0, mrRule.indexOf('- if:', 1));
    };
    const macosMr = mrChanges(/^test:rust:macos:$/m);
    const iosMr = mrChanges(/^test:ios-native:$/m);
    const crates = readdirSync(join(ROOT, 'crates'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(crates).toContain('futo-notes-ffi');
    expect(iosMr).toContain('- crates/futo-notes-ffi/**/*\n');
    for (const crate of crates) {
      const glob = `- crates/${crate}/**/*\n`;
      expect(
        macosMr.includes(glob) || iosMr.includes(glob),
        `crates/${crate} starts neither test:rust:macos nor test:ios-native on MRs`,
      ).toBe(true);
    }
  });

  it('runs full macOS workspace tests on main and tags but not MR pipelines', () => {
    const macosRustJob = topLevelBlock(gitlabPipeline, /^test:rust:macos:$/m);
    const macosRustTask = topLevelBlock(cirrusTasks, /^test_rust_macos_task:$/m);

    // MRs get only the iOS compile check (the workspace suite is the hard
    // Linux gate); the Cirrus task keys the full run off tag/default-branch.
    expect(macosRustTask).toContain('/scripts/rust-tests.mjs\" workspace');
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

  it('keeps iOS tests required for iOS changes while exposing an optional MR run', () => {
    const iosTestJob = topLevelBlock(gitlabPipeline, /^test:ios-native:$/m);

    expect(iosTestJob).toContain('changes: &native-ios-test-changes');
    expect(iosTestJob).toMatch(
      /- \.gitlab-ci\.yml\n    - if: \$CI_MERGE_REQUEST_IID\n      when: manual\n      allow_failure: true/,
    );
    expect(iosTestJob).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(iosTestJob).toContain('$CI_COMMIT_TAG');
  });

  // RC-21 / L1-005: editor.html is built from vite.editor.config.ts and shipped
  // to both native shells, and the bridge specs / Swift bridge tests run against
  // it. An MR touching only a file in that import graph used to drop these jobs
  // to manual+allow_failure. The graph was derived from a real build (rollup
  // getModuleIds over vite.editor.config.ts); the globs below are its directories.
});
