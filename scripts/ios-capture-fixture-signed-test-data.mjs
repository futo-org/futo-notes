import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceProvenance } from './ios-capture-fixture.mjs';

export const selection = {
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
export const profile = {
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

export function sandbox() {
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
