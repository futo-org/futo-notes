import { describe, it, expect } from 'vitest';
import process from 'node:process';
import { validateSigningSelection } from './ios-capture-fixture-signed.mjs';

const selection = {
  formatVersion: 1,
  sourceSHA: 'd39ef4ff792868878cfd6604d196fd33c6c1b5fd',
  sourceFingerprint: 'a'.repeat(64),
  runID: 'A1111111-1111-4111-8111-111111111111',
  deviceUDID: '00000000-0000000000000001',
  identitySHA1: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  teamID: 'TESTTEAM01',
  profileUUID: '11111111-1111-4111-8111-111111111111',
  profileSHA256: 'b'.repeat(64),
  profilePath: '/existing/profile.mobileprovision',
};
const profile = {
  UUID: selection.profileUUID,
  TeamIdentifier: ['TESTTEAM01'],
  ApplicationIdentifierPrefix: ['TESTTEAM01'],
  ExpirationDate: '2027-07-06T16:31:16Z',
  Platform: ['iOS'],
  ProvisionedDevices: [selection.deviceUDID],
  DeveloperCertificates: [selection.identitySHA1],
  Entitlements: {
    'application-identifier': 'TESTTEAM01.*',
    'com.apple.developer.team-identifier': 'TESTTEAM01',
    'get-task-allow': true,
  },
};

describe('explicit existing development profile selection', () => {
  it('accepts a matched wildcard profile only for the fixed isolated bundle family', () => {
    expect(validateSigningSelection(selection, profile, new Date('2026-10-30T00:00:00Z'))).toEqual({
      teamID: 'TESTTEAM01',
      prefix: 'TESTTEAM01',
    });
  });
});

it('refuses extra profile privileges rather than copying unknown entitlements', () => {
  expect(() =>
    validateSigningSelection(
      selection,
      {
        ...profile,
        Entitlements: { ...profile.Entitlements, 'com.apple.developer.unknown': true },
      },
      new Date('2026-10-30T00:00:00Z'),
    ),
  ).toThrow(/profile/);
});

import { buildSignedFixture } from './ios-capture-fixture-signed.mjs';
it('refuses an invalid selection before invoking any OS command or creating output', () => {
  const commands = [];
  expect(() =>
    buildSignedFixture(
      '/missing',
      { ...selection, args: ['-allowProvisioningUpdates'] },
      {
        command: (...args) => commands.push(args),
      },
    ),
  ).toThrow(/selection/);
  expect(commands).toEqual([]);
});

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceProvenance } from './ios-capture-fixture.mjs';

it.each([
  ['expired', { ExpirationDate: '2026-01-01T00:00:00Z' }],
  ['wrong phone', { ProvisionedDevices: ['OTHER'] }],
  ['wrong certificate', { DeveloperCertificates: ['C'.repeat(40)] }],
  ['wrong team', { TeamIdentifier: ['ANOTHER1234'] }],
  ['production profile', { Entitlements: { ...profile.Entitlements, 'get-task-allow': false } }],
  [
    'different app scope',
    {
      Entitlements: {
        ...profile.Entitlements,
        'application-identifier': 'TESTTEAM01.com.futo.notes.dev',
      },
    },
  ],
])('refuses %s', (_name, changes) => {
  expect(() =>
    validateSigningSelection(
      selection,
      { ...profile, ...changes },
      new Date('2026-10-30T00:00:00Z'),
    ),
  ).toThrow();
});

it.each([[[]], [['--selection']], [['--selection', '/missing', '--provision']]])(
  'CLI refuses malformed arguments %j',
  (args) => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'ios-capture-fixture-signed.mjs'), ...args],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected only --selection');
  },
);

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor294-signed-')));
  const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  const fixture = join(root, 'apps/ios/FixtureCapture');
  write(
    join(root, '.gitignore'),
    'existing.mobileprovision\napps/ios/FixtureCapture/.build-signed/\napps/ios/Sources/Generated/\napps/ios/FutoNotesFfi.xcframework/\n',
  );
  write(join(root, 'Cargo.toml'), '[workspace]\n');
  write(
    join(fixture, 'project.yml'),
    JSON.stringify({
      name: 'Editor294Fixture',
      targets: {
        Editor294Fixture: {
          sources: [{ path: 'Sources' }, { path: 'Generated/build-provenance.json' }],
          dependencies: [],
        },
      },
    }),
  );
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const profilePath = join(root, 'existing.mobileprovision');
  write(profilePath, 'approved profile bytes');
  // Existing input is external to selected source, exactly as a real local profile.
  const selected = {
    ...selection,
    ...sourceProvenance(root),
    profilePath,
    identitySHA1: 'A9993E364706816ABA3E25717850C26C9CD0D89D',
    profileSHA256: createHash('sha256').update('approved profile bytes').digest('hex'),
  };
  delete selected.files;
  delete selected.dirtyStatus;
  const currentProfile = { ...profile, DeveloperCertificates: ['YWJj'] };
  const calls = [];
  const command = (program, args, options = {}) => {
    calls.push({ program, args, options });
    const output = join(fixture, '.build-signed', selected.runID);
    if (program === '/usr/bin/security') return 'decoded CMS';
    if (program === '/usr/bin/python3') return JSON.stringify(currentProfile);
    if (program === 'just') {
      for (const path of [
        'Sources/Generated/futo_notes_ffi.swift',
        'FutoNotesFfi.xcframework/Info.plist',
        'FutoNotesFfi.xcframework/ios-arm64/Headers/module.modulemap',
        'FutoNotesFfi.xcframework/ios-arm64/Headers/futo_notes_ffiFFI.h',
        'FutoNotesFfi.xcframework/ios-arm64/libfuto_notes_ffi.a',
        'FutoNotesFfi.xcframework/ios-arm64_x86_64-simulator/libfuto_notes_ffi.a',
      ])
        write(join(root, 'apps/ios', path), 'rebuilt ffi');
    } else if (program === 'xcodebuild') {
      const base = join(output, 'DerivedData/Build/Products/Debug-iphoneos');
      for (const [path, id] of [
        ['Editor294Fixture.app', 'org.futo.fixture.editor294'],
        [
          'Editor294Fixture.app/PlugIns/Editor294FixtureTests.xctest',
          'org.futo.fixture.editor294.tests',
        ],
        ['Editor294FixtureUITests-Runner.app', 'org.futo.fixture.editor294.uitests.xctrunner'],
        [
          'Editor294FixtureUITests-Runner.app/PlugIns/Editor294FixtureUITests.xctest',
          'org.futo.fixture.editor294.uitests',
        ],
      ])
        write(join(base, path, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: id }));
      write(
        join(base, 'Editor294Fixture.app/build-provenance.json'),
        readFileSync(join(output, 'build-provenance.json')),
      );
    } else if (program === '/usr/bin/plutil')
      return options.input ?? readFileSync(args.at(-1), 'utf8');
    else if (program === '/usr/bin/codesign') {
      if (args.includes('--extract-certificates')) write(`${args[2]}0`, 'abc');
      if (args.includes('--entitlements') && args[0] === '--display') {
        const info = JSON.parse(readFileSync(join(args.at(-1), 'Info.plist'), 'utf8'));
        return JSON.stringify({
          'application-identifier': `TESTTEAM01.${info.CFBundleIdentifier}`,
          'com.apple.developer.team-identifier': 'TESTTEAM01',
          'get-task-allow': true,
        });
      }
    }
    return '';
  };
  return { root, selected, command, calls };
}

it('retains a verified four-bundle receipt while bundled provenance stays an unverified request', () => {
  const fixture = sandbox();
  try {
    const result = buildSignedFixture(fixture.root, fixture.selected, {
      command: fixture.command,
      now: () => new Date('2026-10-30T00:00:00Z'),
    });
    expect(result.receipt.signatures.map((item) => item.bundleID)).toEqual([
      'org.futo.fixture.editor294.tests',
      'org.futo.fixture.editor294',
      'org.futo.fixture.editor294.uitests',
      'org.futo.fixture.editor294.uitests.xctrunner',
    ]);
    expect(
      fixture.calls.find(({ program }) => program === 'just').options.env.CARGO_NET_OFFLINE,
    ).toBe('true');
    expect(fixture.calls.find(({ program }) => program === 'xcodebuild').args).toEqual(
      expect.arrayContaining(['-disableAutomaticPackageResolution', '-skipPackageUpdates']),
    );
    expect(result.receipt.provenance.signed).toBe(false);
    expect(result.receipt.provenance.signingStatus).toBe(
      'development-signing-requested-not-verified',
    );
    expect(
      JSON.parse(readFileSync(join(result.output, 'verified-signing-receipt.json'), 'utf8')).kind,
    ).toBe('VERIFIED_SIGNED_ISOLATED_FIXTURE');
    expect(
      fixture.calls.some(({ args }) =>
        args.some((arg) => /allowProvisioning|test-without-building|simctl|devicectl/.test(arg)),
      ),
    ).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});

it('does not sign or retain a verified receipt when the bundled source request was substituted', () => {
  const fixture = sandbox();
  try {
    const command = (program, args, options) => {
      const value = fixture.command(program, args, options);
      if (program === 'xcodebuild')
        writeFileSync(
          join(
            fixture.root,
            'apps/ios/FixtureCapture/.build-signed',
            fixture.selected.runID,
            'DerivedData/Build/Products/Debug-iphoneos/Editor294Fixture.app/build-provenance.json',
          ),
          '{}',
        );
      return value;
    };
    expect(() =>
      buildSignedFixture(fixture.root, fixture.selected, {
        command,
        now: () => new Date('2026-10-30T00:00:00Z'),
      }),
    ).toThrow(/Bundled/);
    expect(fixture.calls.some(({ program }) => program === '/usr/bin/codesign')).toBe(false);
    expect(
      existsSync(
        join(
          fixture.root,
          'apps/ios/FixtureCapture/.build-signed',
          fixture.selected.runID,
          'verified-signing-receipt.json',
        ),
      ),
    ).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});

it('retains failed evidence without a successful receipt after a strict signature failure', () => {
  const fixture = sandbox();
  try {
    const command = (program, args, options) => {
      if (program === '/usr/bin/codesign' && args[0] === '--verify')
        throw new Error('strict signature failed');
      return fixture.command(program, args, options);
    };
    expect(() =>
      buildSignedFixture(fixture.root, fixture.selected, {
        command,
        now: () => new Date('2026-10-30T00:00:00Z'),
      }),
    ).toThrow(/strict signature/);
    const output = join(
      fixture.root,
      'apps/ios/FixtureCapture/.build-signed',
      fixture.selected.runID,
    );
    expect(existsSync(join(output, 'selection.json'))).toBe(true);
    expect(existsSync(join(output, 'verified-signing-receipt.json'))).toBe(false);
    expect(() =>
      buildSignedFixture(fixture.root, fixture.selected, {
        command: fixture.command,
        now: () => new Date('2026-10-30T00:00:00Z'),
      }),
    ).toThrow(/EEXIST/);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});

it('refuses source mismatch and profile hash mismatch before build commands or output', () => {
  for (const changes of [
    { sourceFingerprint: '0'.repeat(64) },
    { profileSHA256: '0'.repeat(64) },
  ]) {
    const fixture = sandbox();
    try {
      expect(() =>
        buildSignedFixture(
          fixture.root,
          { ...fixture.selected, ...changes },
          { command: fixture.command },
        ),
      ).toThrow();
      expect(fixture.calls).toEqual([]);
      expect(existsSync(join(fixture.root, 'apps/ios/FixtureCapture/.build-signed'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true });
    }
  }
});

it('refuses product mutation during signature verification instead of certifying changed bytes', () => {
  const fixture = sandbox();
  try {
    const command = (program, args, options) => {
      const result = fixture.command(program, args, options);
      if (program === '/usr/bin/codesign' && args[0] === '--verify') {
        writeFileSync(join(args.at(-1), 'late-change'), 'changed during verification');
      }
      return result;
    };
    expect(() =>
      buildSignedFixture(fixture.root, fixture.selected, {
        command,
        now: () => new Date('2026-10-30T00:00:00Z'),
      }),
    ).toThrow(/changed during verification/);
    expect(
      existsSync(
        join(
          fixture.root,
          'apps/ios/FixtureCapture/.build-signed',
          fixture.selected.runID,
          'verified-signing-receipt.json',
        ),
      ),
    ).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});

it('refuses a profile for a foreign platform despite matching certificate and phone', () => {
  expect(() =>
    validateSigningSelection(
      selection,
      { ...profile, Platform: ['watchOS'] },
      new Date('2026-10-30T00:00:00Z'),
    ),
  ).toThrow(/profile/);
});

it('validates every compiled identity before any signing operation', () => {
  const fixture = sandbox();
  try {
    const command = (program, args, options) => {
      const result = fixture.command(program, args, options);
      if (program === 'xcodebuild')
        writeFileSync(
          join(
            fixture.root,
            'apps/ios/FixtureCapture/.build-signed',
            fixture.selected.runID,
            'DerivedData/Build/Products/Debug-iphoneos/Editor294FixtureUITests-Runner.app/Info.plist',
          ),
          JSON.stringify({ CFBundleIdentifier: 'com.futo.notes' }),
        );
      return result;
    };
    expect(() =>
      buildSignedFixture(fixture.root, fixture.selected, {
        command,
        now: () => new Date('2026-10-30T00:00:00Z'),
      }),
    ).toThrow(/bundle identity/);
    expect(fixture.calls.some(({ program }) => program === '/usr/bin/codesign')).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});

it('refuses product symlinks before the first signing command', () => {
  const fixture = sandbox();
  try {
    const command = (program, args, options) => {
      const result = fixture.command(program, args, options);
      if (program === 'xcodebuild')
        symlinkSync(
          '/outside',
          join(
            fixture.root,
            'apps/ios/FixtureCapture/.build-signed',
            fixture.selected.runID,
            'DerivedData/Build/Products/Debug-iphoneos/Editor294Fixture.app/foreign-link',
          ),
        );
      return result;
    };
    expect(() =>
      buildSignedFixture(fixture.root, fixture.selected, {
        command,
        now: () => new Date('2026-10-30T00:00:00Z'),
      }),
    ).toThrow(/aliases/);
    expect(fixture.calls.some(({ program }) => program === '/usr/bin/codesign')).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});
