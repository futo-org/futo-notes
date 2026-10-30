import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSignedFixture } from './ios-capture-fixture-signed.mjs';
import { sourceProvenance } from './ios-capture-fixture.mjs';
import { sandbox } from './ios-capture-fixture-signed-test-data.mjs';

it('embeds actual entitlements in both XCTest library signatures under the macOS 15 default', () => {
  const fixture = sandbox();
  const libraryEntitlements = new Map();
  try {
    const command = (program, args, options) => {
      const value = fixture.command(program, args, options);
      if (program === '/usr/bin/codesign' && args.at(-1).endsWith('.xctest')) {
        // codesign(1): library entitlements are omitted by default as of macOS 15.
        if (args.includes('--sign'))
          libraryEntitlements.set(args.at(-1), args.includes('--force-library-entitlements'));
        if (
          args[0] === '--display' &&
          args.includes('--entitlements') &&
          !libraryEntitlements.get(args.at(-1))
        )
          return '';
      }
      return value;
    };
    const result = buildSignedFixture(fixture.root, fixture.selected, {
      command,
      now: () => new Date('2026-10-30T00:00:00Z'),
    });
    expect(
      result.receipt.signatures.filter(
        ({ bundleID }) => bundleID.endsWith('.tests') || bundleID.endsWith('.uitests'),
      ),
    ).toEqual([
      {
        bundleID: 'org.futo.fixture.editor294.tests',
        certificateSHA1: fixture.selected.identitySHA1,
        entitlements: {
          'application-identifier': 'TESTTEAM01.org.futo.fixture.editor294.tests',
          'com.apple.developer.team-identifier': 'TESTTEAM01',
          'get-task-allow': true,
        },
      },
      {
        bundleID: 'org.futo.fixture.editor294.uitests',
        certificateSHA1: fixture.selected.identitySHA1,
        entitlements: {
          'application-identifier': 'TESTTEAM01.org.futo.fixture.editor294.uitests',
          'com.apple.developer.team-identifier': 'TESTTEAM01',
          'get-task-allow': true,
        },
      },
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});

it.each([
  ['/usr/bin/security', 1],
  ['/usr/bin/python3', 1],
  ['just', 1],
  ['xcodegen', 1],
  ['xcodebuild', 1],
  ...Array.from({ length: 12 }, (_, index) => ['/usr/bin/plutil', index + 1]),
  ...[1, 2, 3, 4].flatMap((index) => [
    ['sign', index],
    ['verify', index],
    ['certificate', index],
    ['entitlements', index],
  ]),
])(
  'refuses clean-source certification after unrelated tracked changes at %s %i',
  (phase, occurrence) => {
    const fixture = sandbox();
    let matched = 0;
    try {
      const command = (program, args, options) => {
        const value = fixture.command(program, args, options);
        const current =
          program !== '/usr/bin/codesign'
            ? program
            : args.includes('--sign')
              ? 'sign'
              : args[0] === '--verify'
                ? 'verify'
                : args.some((arg) => arg.startsWith('--extract-certificates='))
                  ? 'certificate'
                  : 'entitlements';
        if (current === phase && ++matched === occurrence)
          writeFileSync(
            join(fixture.root, '.gitignore'),
            readFileSync(join(fixture.root, '.gitignore'), 'utf8') + '# unrelated tracked edit\n',
          );
        return value;
      };
      expect(() =>
        buildSignedFixture(fixture.root, fixture.selected, {
          command,
          now: () => new Date('2026-10-30T00:00:00Z'),
        }),
      ).toThrow(/source/);
      // The selected build inputs remain identical; this is a whole-checkout cleanliness refusal.
      const current = sourceProvenance(fixture.root);
      expect(current.sourceFingerprint).toBe(fixture.selected.sourceFingerprint);
      expect(current.dirtyStatus).toContain('.gitignore');
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
      if (phase === 'xcodebuild' || phase === 'xcodegen')
        expect(fixture.calls.some(({ program }) => program === '/usr/bin/codesign')).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true });
    }
  },
);

it.each([1, 2, 3, 4])(
  'refuses absent, missing or extra actual entitlements on signed bundle %i',
  (occurrence) => {
    for (const alteration of ['absent', 'missing', 'extra']) {
      const fixture = sandbox();
      let displayed = 0;
      try {
        const command = (program, args, options) => {
          const value = fixture.command(program, args, options);
          if (
            program === '/usr/bin/codesign' &&
            args[0] === '--display' &&
            args.includes('--entitlements') &&
            ++displayed === occurrence
          ) {
            if (alteration === 'absent') return '';
            const actual = JSON.parse(value);
            if (alteration === 'missing') delete actual['get-task-allow'];
            else actual['com.apple.developer.unknown'] = true;
            return JSON.stringify(actual);
          }
          return value;
        };
        expect(() =>
          buildSignedFixture(fixture.root, fixture.selected, {
            command,
            now: () => new Date('2026-10-30T00:00:00Z'),
          }),
        ).toThrow(
          alteration === 'absent'
            ? /Unexpected end of JSON input/
            : /Actual signed entitlements differ/,
        );
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
    }
  },
);

it('completes all four leaf checks with Apple certificate extraction semantics', () => {
  const fixture = sandbox();
  try {
    const result = buildSignedFixture(fixture.root, fixture.selected, {
      command: fixture.command,
      now: () => new Date('2026-10-30T00:00:00Z'),
    });
    expect(result.receipt.signatures).toHaveLength(4);
    for (const signature of result.receipt.signatures)
      expect(signature.certificateSHA1).toBe(fixture.selected.identitySHA1);
  } finally {
    rmSync(fixture.root, { recursive: true });
  }
});
