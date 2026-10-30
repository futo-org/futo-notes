import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { sourceProvenance } from '../ios-capture-fixture.mjs';
import { createIOSFixtureExecutor } from './physical-fixture-ios.mjs';

it('rejects an XCTest plan for a personal app before invoking any OS command', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'physical-executor-test-')));
  const commands = [];
  try {
    const executor = createIOSFixtureExecutor(root, {
      runCommand: (...args) => commands.push(args),
    });
    await expect(
      executor.capture(
        { bundleID: 'org.futo.fixture.editor294' },
        {
          xctestrun: {
            Editor294FixtureUITests: { UITargetAppBundleIdentifier: 'com.futo.notes.dev' },
          },
        },
        root,
      ),
    ).rejects.toThrow(/XCTest/);
    expect(commands).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

it('independently verifies local build bytes and refuses a product changed during signature verification', () => {
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
  try {
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
    writeFileSync(
      join(products, 'Editor294Fixture_iphoneos27.2-arm64.xctestrun'),
      'fixed-test-run',
    );
    const executor = createIOSFixtureExecutor(root, {
      runCommand: (command, args) => {
        commands.push(command);
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
                UITargetAppBundleIdentifier: 'org.futo.fixture.editor294',
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
    expect(executor.inspectBuild().buildFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(commands.every((command) => ['plutil', 'codesign'].includes(command))).toBe(true);
    mutate = true;
    expect(() => executor.inspectBuild()).toThrow(/changed during verification/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

it('queries only the two exact fixture identities, without the all-apps override that ignores filters', () => {
  const commands = [];
  const plan = {
    deviceUDID: '00008150-001C70A634F0401C',
    coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
  };
  const executor = createIOSFixtureExecutor('/unused', {
    runCommand: (_command, args) => {
      commands.push(args);
      let result;
      if (args.includes('details'))
        result = {
          device: {
            identifier: plan.coreDeviceID,
            properties: {
              hardware: { udid: plan.deviceUDID, reality: 'physical', platform: 'iOS' },
              state: { bootState: 'booted' },
              connection: { state: 'connected', pairingState: 'paired', transportType: 'wired' },
            },
          },
        };
      else if (args.includes('lockState'))
        result = { passcodeRequired: false, unlockedSinceBoot: true };
      else result = { apps: [], deviceIdentifier: plan.coreDeviceID };
      return { status: 0, stdout: JSON.stringify({ info: { outcome: 'success' }, result }) };
    },
  });
  const device = executor.inspectDevice(plan);
  expect(device.physical && device.available && device.unlocked).toBe(true);
  const inventories = commands.filter((args) => args.includes('apps'));
  expect(inventories.map((args) => args[args.indexOf('--bundle-id') + 1])).toEqual([
    'org.futo.fixture.editor294',
    'org.futo.fixture.editor294.uitests.xctrunner',
  ]);
  expect(inventories.every((args) => !args.includes('--include-all-apps'))).toBe(true);
});

it('runs only the pinned XCTest target and binds its retained attachment to the actual destination', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'physical-executor-test-')));
  const plan = {
    deviceUDID: '00008150-001C70A634F0401C',
    runID: '650D54CC-6339-4D62-B550-834BFBB8D7AA',
    nonce: '9ADC97CB-1A3D-443E-B5C7-62E50B90CDF1',
    seconds: 10,
  };
  const commands = [];
  const xctestrun = {
    __xctestrun_metadata__: { FormatVersion: 1 },
    Editor294FixtureUITests: {
      IsUITestBundle: true,
      UITargetAppBundleIdentifier: 'org.futo.fixture.editor294',
      TestHostBundleIdentifier: 'org.futo.fixture.editor294.uitests.xctrunner',
      TestHostPath: '__TESTROOT__/Debug-iphoneos/Editor294FixtureUITests-Runner.app',
      UITargetAppPath: '__TESTROOT__/Debug-iphoneos/Editor294Fixture.app',
      TestBundlePath: '__TESTHOST__/PlugIns/Editor294FixtureUITests.xctest',
      CommandLineArguments: ['must-not-survive'],
    },
  };
  const gesture = { runID: plan.runID, nonce: plan.nonce, action: 'tap-system-dictate' };
  const executor = createIOSFixtureExecutor(root, {
    runCommand: (command, args) => {
      commands.push([command, args]);
      if (command === 'xcodebuild') {
        const fixed = JSON.parse(readFileSync(args[args.indexOf('-xctestrun') + 1], 'utf8'));
        expect(Object.keys(fixed)).toEqual(['Editor294FixtureUITests', '__xctestrun_metadata__']);
        expect(fixed.Editor294FixtureUITests.CommandLineArguments).toEqual([]);
        expect(fixed.Editor294FixtureUITests.OnlyTestIdentifiers).toEqual([
          'DictationCaptureTests/testCapture',
        ]);
        expect(
          JSON.parse(fixed.Editor294FixtureUITests.EnvironmentVariables.FUTO_EDITOR294_LAUNCH),
        ).toEqual({
          runID: plan.runID,
          nonce: plan.nonce,
          destination: plan.deviceUDID,
          seconds: 10,
        });
        mkdirSync(join(root, 'capture.xcresult'));
        writeFileSync(join(root, 'capture.xcresult/Info.plist'), 'retained result');
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
          }),
        };
      mkdirSync(join(root, 'attachments'));
      writeFileSync(join(root, 'attachments/gesture.json'), JSON.stringify(gesture));
      writeFileSync(
        join(root, 'attachments/manifest.json'),
        JSON.stringify([
          {
            testIdentifier: 'DictationCaptureTests/testCapture()',
            attachments: [
              {
                suggestedHumanReadableName: 'editor294-gesture.json',
                exportedFileName: 'gesture.json',
                deviceId: plan.deviceUDID,
              },
            ],
          },
        ]),
      );
      return { status: 0, stdout: '' };
    },
  });
  try {
    const result = await executor.capture(plan, { xctestrun }, root);
    expect(result.gesture).toEqual(gesture);
    expect(commands[0][1]).toContain(`platform=iOS,id=${plan.deviceUDID}`);
    expect(commands[0][1]).toContain(
      '-only-testing:Editor294FixtureUITests/DictationCaptureTests/testCapture',
    );
    expect(
      JSON.parse(readFileSync(join(root, 'xctest-evidence-hashes.json'), 'utf8')).result,
    ).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true });
  }
});
