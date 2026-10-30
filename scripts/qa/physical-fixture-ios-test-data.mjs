// Disposable compiled products and injected CoreDevice/XCTest responses for
// public adapter tests. No device or signature command is executed.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceProvenance } from '../ios-capture-fixture.mjs';
import { createIOSFixtureExecutor } from './physical-fixture-ios.mjs';

export function setupBuild({ respond = () => undefined, generatedTarget = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'physical-build-test-')));
  const fixture = join(root, 'apps/ios/FixtureCapture');
  const products = join(fixture, '.build-native/Build/Products');
  const app = join(products, 'Debug-iphoneos/Editor294Fixture.app');
  const runner = join(products, 'Debug-iphoneos/Editor294FixtureUITests-Runner.app');
  const artifactPaths = [
    'apps/ios/Sources/Generated/futo_notes_ffi.swift',
    'apps/ios/FutoNotesFfi.xcframework/Info.plist',
    'apps/ios/FutoNotesFfi.xcframework/ios-arm64/Headers/module.modulemap',
    'apps/ios/FutoNotesFfi.xcframework/ios-arm64/Headers/futo_notes_ffiFFI.h',
    'apps/ios/FutoNotesFfi.xcframework/ios-arm64/libfuto_notes_ffi.a',
    'apps/ios/FutoNotesFfi.xcframework/ios-arm64_x86_64-simulator/libfuto_notes_ffi.a',
  ];
  const commands = [];
  let mutate = false;
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]');
  writeFileSync(
    join(root, '.gitignore'),
    'apps/ios/FixtureCapture/Generated/\napps/ios/FixtureCapture/.build-native/\napps/ios/Sources/Generated/\napps/ios/FutoNotesFfi.xcframework/\n',
  );
  execFileSync('git', ['-C', root, 'add', 'Cargo.toml', '.gitignore']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'user.name=Test',
    'commit',
    '-qm',
    'fixture',
  ]);
  for (const path of artifactPaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'bound-ffi');
  }
  const provenance = {
    ...sourceProvenance(root),
    artifacts: artifactPaths.map((path) => ({
      path,
      sha256: createHash('sha256').update('bound-ffi').digest('hex'),
    })),
  };
  mkdirSync(join(fixture, 'Generated'), { recursive: true });
  mkdirSync(app, { recursive: true });
  mkdirSync(runner, { recursive: true });
  writeFileSync(join(fixture, 'Generated/build-provenance.json'), JSON.stringify(provenance));
  writeFileSync(join(app, 'build-provenance.json'), JSON.stringify(provenance));
  writeFileSync(join(app, 'Info.plist'), 'fixed-app');
  writeFileSync(join(runner, 'Info.plist'), 'fixed-runner');
  writeFileSync(join(products, 'Editor294Fixture_iphoneos27.2-arm64.xctestrun'), 'fixed-test-run');
  const executor = createIOSFixtureExecutor(root, {
    runCommand: (command, args) => {
      commands.push(command === 'xcrun' ? [command, args] : command);
      const response = respond(command, args);
      if (response !== undefined) return response;
      if (command === 'plutil') {
        const path = args.at(-1);
        if (path.endsWith('Info.plist'))
          return {
            status: 0,
            stdout: JSON.stringify({
              CFBundleIdentifier: path.includes('UITests-Runner')
                ? 'org.futo.fixture.editor294.uitests.xctrunner'
                : 'org.futo.fixture.editor294',
            }),
          };
        return {
          status: 0,
          stdout: JSON.stringify({
            __xctestrun_metadata__: { FormatVersion: 1 },
            Editor294FixtureUITests: {
              IsUITestBundle: true,
              ...(generatedTarget
                ? {}
                : { UITargetAppBundleIdentifier: 'org.futo.fixture.editor294' }),
              TestHostBundleIdentifier: 'org.futo.fixture.editor294.uitests.xctrunner',
              TestHostPath: '__TESTROOT__/Debug-iphoneos/Editor294FixtureUITests-Runner.app',
              UITargetAppPath: '__TESTROOT__/Debug-iphoneos/Editor294Fixture.app',
              TestBundlePath: '__TESTHOST__/PlugIns/Editor294FixtureUITests.xctest',
            },
          }),
        };
      }
      if (mutate && args.includes('--display'))
        writeFileSync(join(app, 'changed-during-verification'), 'changed');
      return { status: 0, stdout: '', stderr: 'Authority=Mock signing metadata only\n' };
    },
  });
  return {
    root,
    app,
    runner,
    products,
    executor,
    commands,
    mutate: () => {
      mutate = true;
    },
  };
}

export function setupScenario(change = {}) {
  let output;
  const plan = {
    bundleID: 'org.futo.fixture.editor294',
    deviceUDID: '00008150-001C70A634F0401C',
    coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
    runID: '650D54CC-6339-4D62-B550-834BFBB8D7AA',
    nonce: '9ADC97CB-1A3D-443E-B5C7-62E50B90CDF1',
    seconds: 10,
  };
  const gesture = {
    runID: plan.runID,
    nonce: plan.nonce,
    bundleID: plan.bundleID,
    destination: plan.deviceUDID,
    action: 'tap-system-dictate',
    status: 'capture-window-ended',
    control: { label: 'Dictate', hittable: true, frame: { x: 1, y: 2, width: 30, height: 40 } },
    ...change.gesture,
  };
  const calls = [];
  const t = setupBuild({
    respond(command, args) {
      if (!['xcodebuild', 'xcrun'].includes(command)) return;
      calls.push([command, args]);
      if (command === 'xcodebuild') {
        const fixed = JSON.parse(readFileSync(args[args.indexOf('-xctestrun') + 1], 'utf8'));
        expect(Object.keys(fixed)).toEqual(['Editor294FixtureUITests', '__xctestrun_metadata__']);
        expect(fixed.Editor294FixtureUITests.CommandLineArguments).toEqual([]);
        expect(fixed.Editor294FixtureUITests.OnlyTestIdentifiers).toEqual([
          'DictationCaptureTests/testCapture',
        ]);
        expect(
          fixed.Editor294FixtureUITests.UITargetAppPath.startsWith(output + '/pinned-products/'),
        ).toBe(true);
        expect(
          JSON.parse(fixed.Editor294FixtureUITests.EnvironmentVariables.FUTO_EDITOR294_LAUNCH),
        ).toEqual({
          runID: plan.runID,
          nonce: plan.nonce,
          destination: plan.deviceUDID,
          seconds: 10,
        });
        mkdirSync(join(output, 'capture.xcresult'));
        writeFileSync(join(output, 'capture.xcresult/Info.plist'), 'retained result');
        return { status: 0, stdout: 'one fixed test' };
      }
      if (args.includes('summary'))
        return {
          status: 0,
          stdout: JSON.stringify({
            totalTestCount: 1,
            passedTests: 1,
            failedTests: 0,
            skippedTests: 0,
            devicesAndConfigurations: [{ device: { deviceId: plan.deviceUDID, platform: 'iOS' } }],
            ...change.summary,
          }),
        };
      mkdirSync(join(output, 'attachments'));
      writeFileSync(join(output, 'attachments/gesture.json'), JSON.stringify(gesture));
      const item = {
        suggestedHumanReadableName: 'editor294-gesture.json',
        exportedFileName: 'gesture.json',
        deviceId: plan.deviceUDID,
        ...change.attachment,
      };
      writeFileSync(
        join(output, 'attachments/manifest.json'),
        JSON.stringify(
          change.manifest ?? [
            {
              testIdentifier: 'DictationCaptureTests/testCapture()',
              attachments: change.duplicate ? [item, item] : [item],
            },
          ],
        ),
      );
      if (change.exportSymlink) {
        const path = join(
          output,
          change.exportSymlink === 'file' ? 'attachments/gesture.json' : 'attachments',
        );
        renameSync(path, path + '-retained');
        symlinkSync(path + '-retained', path);
      }
      return { status: 0, stdout: '' };
    },
  });
  output = join(t.root, 'run');
  mkdirSync(output, { mode: 0o700 });
  const build = t.executor.pinBuild(plan, t.executor.inspectBuild(), output);
  return { ...t, output, plan, build, calls, gesture };
}
