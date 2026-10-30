import { setupBuild, setupScenario } from './physical-fixture-ios-test-data.mjs';
import {
  lstatSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
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
            __xctestrun_metadata__: { FormatVersion: 1 },
            Editor294FixtureUITests: {
              IsUITestBundle: true,
              UITargetAppBundleIdentifier: 'com.futo.notes.dev',
              TestHostBundleIdentifier: 'org.futo.fixture.editor294.uitests.xctrunner',
              TestHostPath: '__TESTROOT__/Debug-iphoneos/Editor294FixtureUITests-Runner.app',
              UITargetAppPath: '__TESTROOT__/Debug-iphoneos/Editor294Fixture.app',
              TestBundlePath: '__TESTHOST__/PlugIns/Editor294FixtureUITests.xctest',
            },
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
  const t = setupBuild();
  try {
    expect(t.executor.inspectBuild().buildFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(t.commands.every((command) => ['plutil', 'codesign'].includes(command))).toBe(true);
    t.mutate();
    expect(() => t.executor.inspectBuild()).toThrow(/changed during verification/);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it('pins verified app, runner and XCTest bytes and installs only the private snapshot after shared product mutation', async () => {
  const t = setupBuild();
  try {
    const build = t.executor.inspectBuild();
    const output = join(t.root, 'run');
    mkdirSync(output, { mode: 0o700 });
    const pinned = await t.executor.pinBuild({}, build, output);
    writeFileSync(join(t.app, 'Info.plist'), 'changed-personal-identity');
    writeFileSync(join(t.runner, 'Info.plist'), 'changed-runner');
    writeFileSync(
      join(t.products, 'Editor294Fixture_iphoneos27.2-arm64.xctestrun'),
      'changed-xctest',
    );
    // Installation will fail on this intentionally incomplete mock receipt, but
    // the actual adapter must submit only the retained verified bytes.
    await expect(t.executor.installFixture({}, pinned, output)).rejects.toThrow();
    const installed = t.commands.find((item) => Array.isArray(item) && item[1].includes('install'));
    expect(installed).toBeDefined();
    const path = installed[1][installed[1].indexOf('app') + 1];
    expect(path.startsWith(output + '/')).toBe(true);
    expect(readFileSync(join(path, 'Info.plist'), 'utf8')).toBe('fixed-app');
  } finally {
    rmSync(t.root, { recursive: true });
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
        result = {
          deviceIdentifier: plan.coreDeviceID,
          passcodeRequired: false,
          unlockedSinceBoot: true,
        };
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
  const t = setupScenario();
  try {
    expect((await t.executor.capture(t.plan, t.build, t.output)).gesture).toEqual(t.gesture);
    expect(t.calls[0][1]).toContain(`platform=iOS,id=${t.plan.deviceUDID}`);
    expect(t.calls[0][1]).toContain(
      '-only-testing:Editor294FixtureUITests/DictationCaptureTests/testCapture',
    );
    expect(
      JSON.parse(readFileSync(join(t.output, 'xctest-evidence-hashes.json'), 'utf8')).result,
    ).toHaveLength(1);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it.each([
  ['zero tests', { summary: { totalTestCount: 0, passedTests: 0 } }],
  ['skipped test', { summary: { skippedTests: 1 } }],
  [
    'wrong destination',
    {
      summary: { devicesAndConfigurations: [{ device: { deviceId: 'foreign', platform: 'iOS' } }] },
    },
  ],
  ['missing destination', { summary: { devicesAndConfigurations: null } }],
  [
    'unknown destination platform',
    {
      summary: {
        devicesAndConfigurations: [
          { device: { deviceId: '00008150-001C70A634F0401C', platform: 'iOS Simulator' } },
        ],
      },
    },
  ],
  ['symlink gesture file', { exportSymlink: 'file' }],
  ['symlink attachment directory', { exportSymlink: 'directory' }],
  ['missing gesture', { manifest: [] }],
  ['ambiguous gesture', { duplicate: true }],
  ['wrong gesture test', { manifest: [{ testIdentifier: 'Other/test()', attachments: [] }] }],
  ['malformed attachment manifest', { manifest: { unknown: true } }],
  ['wrong gesture device', { attachment: { deviceId: 'foreign' } }],
  ['traversing gesture filename', { attachment: { exportedFileName: '../outside' } }],
  ['wrong run gesture', { gesture: { runID: 'foreign' } }],
  ['wrong nonce gesture', { gesture: { nonce: 'foreign' } }],
  ['absent Dictate', { gesture: { control: { label: 'Other', hittable: false } } }],
])('actual adapter refuses %s from injected provider output', async (_name, change) => {
  const t = setupScenario(change);
  try {
    await expect(t.executor.capture(t.plan, t.build, t.output)).rejects.toThrow();
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it.each(['capture.xctestrun', 'capture.xcresult', 'attachments', 'xctest-command.json'])(
  'actual adapter refuses a preexisting %s output before XCTest',
  async (name) => {
    const t = setupScenario();
    try {
      const path = join(t.output, name);
      writeFileSync(path, 'sentinel', { mode: 0o600 });
      await expect(t.executor.capture(t.plan, t.build, t.output)).rejects.toThrow(/collision/);
      expect(t.calls).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe('sentinel');
    } finally {
      rmSync(t.root, { recursive: true });
    }
  },
);

it.each(['capture.raw.json', 'copy-artifact-command.json'])(
  'actual adapter refuses a symlink %s before copying from a device',
  (name) => {
    const t = setupScenario();
    try {
      const outside = join(t.root, 'outside.json');
      writeFileSync(outside, 'sentinel', { mode: 0o600 });
      symlinkSync(outside, join(t.output, name));
      expect(() => t.executor.copyArtifact(t.plan, t.output)).toThrow(/evidence|collision/);
      expect(t.calls).toEqual([]);
      expect(readFileSync(outside, 'utf8')).toBe('sentinel');
    } finally {
      rmSync(t.root, { recursive: true });
    }
  },
);

it('actual adapter refuses changed private products before installation', async () => {
  const t = setupScenario();
  try {
    const path = join(
      t.output,
      'pinned-products/Products/Debug-iphoneos/Editor294Fixture.app/Info.plist',
    );
    writeFileSync(path, 'changed');
    await expect(t.executor.installFixture(t.plan, t.build, t.output)).rejects.toThrow(
      /Pinned.*changed/,
    );
    expect(t.calls).toEqual([]);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it('actual adapter refuses changed source between fixture and runner installation', async () => {
  const t = setupScenario();
  try {
    writeFileSync(join(t.root, 'Cargo.toml'), 'changed-source');
    await expect(t.executor.installRunner(t.plan, t.build, t.output)).rejects.toThrow(
      /source differs/,
    );
    expect(t.calls).toEqual([]);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it.each(['symlink-file', 'symlink-directory'])(
  'actual adapter rejects provider-created %s attachment evidence without reading it',
  async (kind) => {
    const t = setupScenario();
    const original = t.executor;
    // Exercise the same injected provider boundary as the successful scenario;
    // replace its retained files between export and the adapter read.
    const saved = t.calls;
    try {
      await original.capture(t.plan, t.build, t.output);
      const path = join(
        t.output,
        kind === 'symlink-file' ? 'attachments/gesture.json' : 'attachments',
      );
      renameSync(path, path + '-retained');
      symlinkSync(path + '-retained', path);
      const calls = saved.length;
      await expect(original.installFixture(t.plan, t.build, t.output)).rejects.toThrow(/evidence/);
      expect(saved).toHaveLength(calls);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(t.root, { recursive: true });
    }
  },
);

it.each([
  ['malformed JSON', 'details', '{'],
  ['unknown details', 'details', {}],
  ['wrong details device', 'details', { device: { identifier: 'foreign' } }],
  ['unknown lock', 'lockState', {}],
  ['locked device', 'lockState', { passcodeRequired: true, unlockedSinceBoot: true }],
  [
    'wrong lock destination',
    'lockState',
    { deviceIdentifier: 'foreign', passcodeRequired: false, unlockedSinceBoot: true },
  ],
  ['unknown apps', 'apps', { apps: { unknown: true } }],
  ['wrong inventory destination', 'apps', { deviceIdentifier: 'foreign', apps: [] }],
  [
    'wrong inventory filter',
    'apps',
    {
      apps: [
        { bundleIdentifier: 'com.futo.notes.dev', bundleVersion: '1', url: 'file:///foreign' },
      ],
    },
  ],
  ['partial inventory', 'apps', { apps: [{ bundleIdentifier: 'org.futo.fixture.editor294' }] }],
])('actual adapter refuses %s from CoreDevice', (_name, operation, replacement) => {
  const plan = {
    deviceUDID: '00008150-001C70A634F0401C',
    coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
  };
  const commands = [];
  const executor = createIOSFixtureExecutor('/unused', {
    runCommand: (_command, args) => {
      commands.push(args);
      let result = args.includes('details')
        ? {
            device: {
              identifier: plan.coreDeviceID,
              properties: {
                hardware: { udid: plan.deviceUDID, reality: 'physical', platform: 'iOS' },
                state: { bootState: 'booted' },
                connection: { pairingState: 'paired', state: 'connected', transportType: 'wired' },
              },
            },
          }
        : args.includes('lockState')
          ? {
              deviceIdentifier: plan.coreDeviceID,
              passcodeRequired: false,
              unlockedSinceBoot: true,
            }
          : { deviceIdentifier: plan.coreDeviceID, apps: [] };
      if (args.includes(operation)) {
        if (typeof replacement === 'string') return { status: 0, stdout: replacement };
        result = { ...replacement };
        if (!Object.hasOwn(result, 'deviceIdentifier') && operation !== 'details')
          result.deviceIdentifier = plan.coreDeviceID;
      }
      return { status: 0, stdout: JSON.stringify({ info: { outcome: 'success' }, result }) };
    },
  });
  expect(() => executor.inspectDevice(plan)).toThrow();
  expect(commands.every((args) => args.includes('info'))).toBe(true);
});

it.each([
  null,
  {},
  { installedApplications: [] },
  {
    deviceIdentifier: 'foreign',
    installedApplications: [{ bundleID: 'org.futo.fixture.editor294' }],
  },
  { installedApplications: [{ bundleID: 'com.futo.notes.dev' }] },
  {
    installedApplications: [
      { bundleID: 'org.futo.fixture.editor294' },
      { bundleID: 'org.futo.fixture.editor294' },
    ],
  },
])('actual adapter refuses malformed or foreign install receipt %j', async (replacement) => {
  let installation = false;
  const t = setupBuild({
    respond(command, _args) {
      if (command !== 'xcrun') return;
      installation = true;
      return {
        status: 0,
        stdout: JSON.stringify({
          info: { outcome: 'success' },
          result: replacement && {
            deviceIdentifier: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
            ...replacement,
          },
        }),
      };
    },
  });
  try {
    const output = join(t.root, 'run');
    mkdirSync(output, { mode: 0o700 });
    const build = t.executor.pinBuild({}, t.executor.inspectBuild(), output);
    await expect(
      t.executor.installFixture(
        { coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478' },
        build,
        output,
      ),
    ).rejects.toThrow();
    expect(installation).toBe(true);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it('actual adapter rejects products changed while validating a private copy before any install', () => {
  let output;
  const t = setupBuild({
    respond(command, args) {
      if (command === 'plutil' && output && args.at(-1).includes('/pinned-products/'))
        writeFileSync(
          join(output, 'pinned-products/Products/Debug-iphoneos/Editor294Fixture.app/Info.plist'),
          'changed-copy',
        );
    },
  });
  try {
    const build = t.executor.inspectBuild();
    output = join(t.root, 'run');
    mkdirSync(output, { mode: 0o700 });
    expect(() => t.executor.pinBuild({}, build, output)).toThrow(/changed while pinning/);
    expect(t.commands.every((command) => typeof command === 'string')).toBe(true);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it('accepts the generated Xcode UI target whose app identity is attested by its fixed path and compiled Info.plist', () => {
  const t = setupBuild({ generatedTarget: true });
  try {
    const build = t.executor.inspectBuild();
    expect(build.xctestrun.Editor294FixtureUITests.UITargetAppBundleIdentifier).toBeUndefined();
    const output = join(t.root, 'run');
    mkdirSync(output, { mode: 0o700 });
    expect(t.executor.pinBuild({}, build, output).buildFingerprint).toBe(build.buildFingerprint);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});

it.each(
  [['gesture.json'], [['gesture.json']], null, true, 1, {}, '.', '..'].map((value) => [value]),
)(
  'refuses a non-file or typed-malformed exported attachment name %j before reading it',
  async (exportedFileName) => {
    const t = setupScenario({ attachment: { exportedFileName } });
    try {
      await expect(t.executor.capture(t.plan, t.build, t.output)).rejects.toThrow(
        /attachment.*missing or ambiguous/,
      );
    } finally {
      rmSync(t.root, { recursive: true });
    }
  },
);

it.each(
  [['Authority=Mock'], [['Authority=Mock']], Object('Authority=Mock')].map((value) => [value]),
)('refuses a coercible local signature response %j before any device command', (stderr) => {
  const t = setupBuild({
    respond(command, args) {
      if (command === 'codesign' && args.includes('--display'))
        return { status: 0, stdout: '', stderr };
    },
  });
  try {
    expect(() => t.executor.inspectBuild()).toThrow(/signed fixture build is unavailable/);
    expect(t.commands.every((command) => typeof command === 'string')).toBe(true);
  } finally {
    rmSync(t.root, { recursive: true });
  }
});
