import { describe, it, expect, vi } from 'vitest';
import process from 'node:process';
import { validateSigningSelection } from './ios-capture-fixture-signed.mjs';

// Subprocess-driven file: each case spawns the capture script through spawnSync. The 5s default went red on loaded
// CI runners (audit 2026-11), so the file timeout is set to 30s to cover that bound.
vi.setConfig({ testTimeout: 30_000 });

describe('explicit existing development profile selection', () => {
  it('accepts a matched wildcard profile only for the fixed isolated bundle family', () => {
    expect(validateSigningSelection(selection, profile, new Date('2026-10-30T00:00:00Z'))).toEqual({
      teamID: 'TESTTEAM01',
      prefix: 'TESTTEAM01',
    });
  });
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

import { writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selection, profile, sandbox } from './ios-capture-fixture-signed-test-data.mjs';

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
