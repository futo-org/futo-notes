import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  linkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireLease, releaseLease } from './physical-fixture-lease.mjs';
import { runPhysicalFixtureCLI } from './physical-fixture-cli.mjs';
import process from 'node:process';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { expect, it } from 'vitest';
import { setupBuild } from './physical-fixture-ios-test-data.mjs';

it('requires a strict signed run UUID before any OS call', () => {
  const t = setupBuild();
  expect(() => t.executor.inspectBuild()).toThrow(/run UUID/);
  expect(t.commands).toEqual([]);
});

it('consumes only the signed UUID output and keeps bundled request metadata distinct', () => {
  const t = setupBuild();
  const build = t.executor.inspectBuild(t.plan);
  expect(build.products).toContain(`/.build-signed/${t.plan.runID}/DerivedData/Build/Products`);
  expect(build.provenance.signed).toBe(false);
  expect(build.signing).toEqual({
    status: 'independently-verified-signed-output',
    runID: t.plan.runID,
  });
});

it.each(['runID', 'deviceUDID', 'sourceSHA', 'sourceFingerprint'])(
  'refuses a signed output selected for another %s',
  (field) => {
    const t = setupBuild();
    expect(() =>
      t.executor.inspectBuild({
        ...t.plan,
        [field]: field === 'runID' ? 'B1111111-1111-4111-8111-111111111111' : 'foreign',
      }),
    ).toThrow();
    expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
  },
);

const identityCLI = fileURLToPath(new URL('./physical-fixture-ios.mjs', import.meta.url));
const receiptName = 'verified-signing-receipt.json';
it.each([
  [
    'missing external verification',
    (receipt) => {
      receipt.kind = 'requested';
    },
  ],
  [
    'unknown receipt field',
    (receipt) => {
      receipt.waiver = true;
    },
  ],
  [
    'coerced physical state',
    (receipt) => {
      receipt.physicalActions = 'false';
    },
  ],
  [
    'wrong receipt source',
    (receipt) => {
      receipt.sourceSHA = '0'.repeat(40);
    },
  ],
  [
    'false bundled signed claim',
    (receipt) => {
      receipt.provenance.signed = true;
    },
  ],
  [
    'absent actual signatures',
    (receipt) => {
      receipt.signatures = [];
    },
  ],
  [
    'unknown artifact hash',
    (receipt) => {
      receipt.artifacts[0].sha256 = '0'.repeat(64);
    },
  ],
])('refuses %s without device access', (_name, change) => {
  const t = setupBuild();
  const path = join(t.signedOutput, receiptName);
  const receipt = JSON.parse(readFileSync(path));
  change(receipt);
  writeFileSync(path, JSON.stringify(receipt));
  expect(() => t.executor.inspectBuild(t.plan)).toThrow();
  expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
});
it.each([
  'receipt-symlink',
  'receipt-hardlink',
  'receipt-public',
  'product-hardlink',
  'output-alias',
])('refuses %s at the public executor boundary', (kind) => {
  const t = setupBuild();
  const receipt = join(t.signedOutput, receiptName);
  if (kind === 'receipt-public') chmodSync(receipt, 0o644);
  else if (kind === 'product-hardlink') linkSync(join(t.app, 'Info.plist'), join(t.app, 'alias'));
  else if (kind === 'output-alias') {
    renameSync(t.signedOutput, t.signedOutput + '-retained');
    symlinkSync(t.signedOutput + '-retained', t.signedOutput);
  } else {
    renameSync(receipt, receipt + '-retained');
    if (kind === 'receipt-symlink') symlinkSync(receipt + '-retained', receipt);
    else linkSync(receipt + '-retained', receipt);
  }
  expect(() => t.executor.inspectBuild(t.plan)).toThrow();
  expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
});
it.each([
  'same-byte receipt replacement',
  'same-byte product replacement',
  'profile replacement',
  'unrelated source edit',
])('refuses %s after inspection and before copying', (kind) => {
  const t = setupBuild();
  const build = t.executor.inspectBuild(t.plan);
  const output = join(t.root, 'run');
  mkdirSync(output, { mode: 0o700 });
  if (kind === 'unrelated source edit') writeFileSync(join(t.root, 'Cargo.toml'), 'changed');
  else {
    const path =
      kind === 'same-byte receipt replacement'
        ? join(t.signedOutput, receiptName)
        : kind === 'profile replacement'
          ? t.plan.profilePath
          : join(t.app, 'Info.plist');
    const bytes = readFileSync(path);
    renameSync(path, join(output, 'retained-file'));
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(readFileSync(path)).toEqual(bytes);
  }
  expect(() => t.executor.pinBuild(t.plan, build, output)).toThrow();
  expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
});
it.each([
  ['profile', 0],
  ...[0, 1, 2, 3].flatMap((index) => ['leaf', 'entitlements'].map((kind) => [kind, index])),
])(
  'independently refuses wrong actual %s on bundle %i despite a complete signed receipt',
  (kind, index) => {
    const bundles = [
      'Editor294FixtureTests.xctest',
      'Editor294Fixture.app',
      'Editor294FixtureUITests.xctest',
      'Editor294FixtureUITests-Runner.app',
    ];
    const t = setupBuild({
      respond(command, args) {
        if (
          kind === 'entitlements' &&
          args.at(-1).endsWith(bundles[index]) &&
          command === '/usr/bin/codesign' &&
          args.includes('--entitlements')
        )
          return { status: 0, stdout: '{}' };
        if (
          kind === 'leaf' &&
          args.at(-1).endsWith(bundles[index]) &&
          command === '/usr/bin/codesign' &&
          args.some((arg) => arg.startsWith('--extract-certificates='))
        ) {
          writeFileSync(args[1].slice('--extract-certificates='.length) + '0', 'wrong certificate');
          return { status: 0, stdout: '' };
        }
        if (kind === 'profile' && command === '/usr/bin/python3')
          return { status: 0, stdout: '{}' };
      },
    });
    expect(() => t.executor.inspectBuild(t.plan)).toThrow();
    expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
  },
);

it.each(
  [
    [],
    ['--identity'],
    ['--identity', '--run', '../other'],
    ['--identity', '--run', 'A1111111-1111-4111-8111-111111111111', '--runner', 'foreign'],
  ].map((args) => [args]),
)('actual local identity CLI refuses missing/foreign selectors %j', (args) => {
  const result = spawnSync(process.execPath, [identityCLI, ...args], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Only --identity --run <UUID>');
});

it('refuses a mutated returned build capability before selecting any installation path', async () => {
  const t = setupBuild();
  const output = join(t.root, 'run');
  mkdirSync(output, { mode: 0o700 });
  const build = t.executor.pinBuild(t.plan, t.executor.inspectBuild(t.plan), output);
  build.app = '/foreign-personal.app';
  await expect(t.executor.installFixture(t.plan, build, output)).rejects.toThrow();
  expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
});

it.each(['cms', 'serializer', 'info-plist', 'verify', 'certificate', 'entitlements', 'xctestrun'])(
  'refuses identical-byte receipt replacement at the %s OS boundary',
  (boundary) => {
    let t;
    let changed = false;
    t = setupBuild({
      respond(command, args) {
        const matches =
          boundary === 'cms'
            ? command === '/usr/bin/security'
            : boundary === 'serializer'
              ? command === '/usr/bin/python3'
              : boundary === 'info-plist'
                ? command === 'plutil' && args.at(-1).endsWith('Info.plist')
                : boundary === 'xctestrun'
                  ? command === 'plutil' && args.at(-1).endsWith('.xctestrun')
                  : command === '/usr/bin/codesign' &&
                    args.some(
                      (arg) =>
                        arg.split('=')[0] ===
                        (boundary === 'verify'
                          ? '--verify'
                          : boundary === 'certificate'
                            ? '--extract-certificates'
                            : '--entitlements'),
                    );
        if (matches && !changed) {
          changed = true;
          const path = join(t.signedOutput, receiptName);
          const bytes = readFileSync(path);
          renameSync(path, path + '-retained');
          writeFileSync(path, bytes, { mode: 0o600 });
        }
      },
    });
    expect(() => t.executor.inspectBuild(t.plan)).toThrow();
    expect(changed).toBe(true);
    expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
  },
);
it('refuses same-byte private product replacement before installation', async () => {
  const t = setupBuild();
  const output = join(t.root, 'run');
  mkdirSync(output, { mode: 0o700 });
  const build = t.executor.pinBuild(t.plan, t.executor.inspectBuild(t.plan), output);
  const path = join(
    output,
    'pinned-products/Products/Debug-iphoneos/Editor294Fixture.app/Info.plist',
  );
  const bytes = readFileSync(path);
  renameSync(path, path + '-retained');
  // Preserve the same complete file set while changing only the file identity.
  renameSync(path + '-retained', join(t.root, 'run/retained-info'));
  writeFileSync(path, bytes, { mode: 0o600 });
  await expect(t.executor.installFixture(t.plan, build, output)).rejects.toThrow();
  expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
});

it('accepts exact minimal producer entitlements independently of dictionary-key ordering', () => {
  const t = setupBuild({ reverseSigningEntitlements: true });
  const receipt = JSON.parse(readFileSync(join(t.signedOutput, receiptName)));
  expect(Object.keys(receipt.signatures[0].entitlements)).toEqual([
    'get-task-allow',
    'com.apple.developer.team-identifier',
    'application-identifier',
  ]);
  expect(t.executor.inspectBuild(t.plan).signing.status).toBe(
    'independently-verified-signed-output',
  );
});

it('binds the approved build fingerprint to receipt inodes across independent inspections', () => {
  const t = setupBuild();
  const approved = t.executor.inspectBuild(t.plan).buildFingerprint;
  const path = join(t.signedOutput, receiptName);
  const bytes = readFileSync(path);
  renameSync(path, path + '-retained');
  writeFileSync(path, bytes, { mode: 0o600 });
  expect(readFileSync(path)).toEqual(bytes);
  expect(t.executor.inspectBuild(t.plan).buildFingerprint).not.toBe(approved);
});

it('keeps honest independent inspection fingerprints equal without binding verification temp state', () => {
  const t = setupBuild();
  const first = t.executor.inspectBuild(t.plan).buildFingerprint;
  expect(t.executor.inspectBuild(t.plan).buildFingerprint).toBe(first);
});

it('the actual capture CLI refuses a same-byte receipt swap since identity approval before any device command', async () => {
  const t = setupBuild();
  const approved = t.executor.inspectBuild(t.plan).buildFingerprint;
  const run = join(t.root, 'run');
  mkdirSync(run, { mode: 0o700 });
  const plan = {
    formatVersion: 1,
    host: hostname(),
    worktree: t.root,
    deviceUDID: t.plan.deviceUDID,
    coreDeviceID: '11111111-1111-4111-8111-111111111111',
    sourceSHA: t.plan.sourceSHA,
    sourceFingerprint: t.plan.sourceFingerprint,
    runID: t.plan.runID,
    nonce: '22222222-2222-4222-8222-222222222222',
    ownerPID: process.pid,
    bundleID: 'org.futo.fixture.editor294',
    runnerBundleID: 'org.futo.fixture.editor294.uitests.xctrunner',
    seconds: 10,
    buildFingerprint: approved,
  };
  const leaseRuntime = { directory: join(run, 'leases'), host: plan.host };
  const manifest = join(run, 'manifest.json');
  writeFileSync(manifest, JSON.stringify(plan), { mode: 0o600 });
  acquireLease(plan, leaseRuntime);
  try {
    const receipt = join(t.signedOutput, receiptName);
    const bytes = readFileSync(receipt);
    renameSync(receipt, join(run, 'retained-receipt'));
    writeFileSync(receipt, bytes, { mode: 0o600 });
    expect(readFileSync(receipt)).toEqual(bytes);
    await expect(
      runPhysicalFixtureCLI(['capture', '--manifest', manifest], {
        root: t.root,
        host: plan.host,
        scratch: join(run, 'captures'),
        leaseRuntime,
        executor: t.executor,
      }),
    ).rejects.toThrow('Physical fixture source or build identity differs');
    expect(t.commands.some((item) => Array.isArray(item))).toBe(false);
  } finally {
    releaseLease(plan, leaseRuntime);
  }
});

it.each(['receipt', 'selection', 'profile'])(
  'refuses a real FIFO %s through the public executor without blocking or invoking the OS provider',
  (kind) => {
    const t = setupBuild();
    const path =
      kind === 'receipt'
        ? join(t.signedOutput, receiptName)
        : kind === 'selection'
          ? join(t.signedOutput, 'selection.json')
          : t.plan.profilePath;
    renameSync(path, path + '-retained');
    execFileSync('mkfifo', [path], { timeout: 2000 });
    chmodSync(path, 0o600);
    const code = `
      import { createIOSFixtureExecutor } from ${JSON.stringify(new URL('./physical-fixture-ios.mjs', import.meta.url).href)};
      let calls = 0;
      try {
        createIOSFixtureExecutor(${JSON.stringify(t.root)}, { runCommand() { calls++; throw new Error('UNEXPECTED OS PROVIDER'); } })
          .inspectBuild(${JSON.stringify(t.plan)});
        console.log(JSON.stringify({ accepted: true, calls }));
      } catch (error) { console.log(JSON.stringify({ accepted: false, error: error.message, calls })); }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 2000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: false,
      error: 'Signed fixture requires owned single-link regular files',
      calls: 0,
    });
  },
);

it('independently checks the signed output with Apple certificate extraction semantics', () => {
  const t = setupBuild();
  const build = t.executor.inspectBuild(t.plan);
  expect(build.signing.status).toBe('independently-verified-signed-output');
  expect(t.commands.some((command) => Array.isArray(command))).toBe(false);
});
