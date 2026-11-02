#!/usr/bin/env node
// Editor294Fixture preparation. Default: compile-only, always rebuilding release-ffi
// and binding source/facade/library/recorder bytes into bundled provenance. No device
// access in build mode. --test-simulator runs only synthetic native unit tests on an
// already claimed booted pool simulator; no claim, physical input, dictation or signing.
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { findSim } from './qa/ios-simulators.mjs';
import { POOL, readOwner } from './qa/pool.mjs';

const inputs = [
  'Cargo.toml',
  'Cargo.lock',
  'crates',
  'apps/ios/FixtureCapture',
  'apps/ios/Sources/InputCapture',
  'apps/ios/Sources/App/NativeInputRecorderScope.swift',
  'scripts/ios-capture-fixture.mjs',
  'scripts/ios-capture-fixture-signed.mjs',
  'scripts/qa/physical-fixture*.mjs',
  'scripts/build-rust-ios.sh',
  'just/mobile.justfile',
  'just/qa.justfile',
];
const ffiArtifactPaths = [
  'apps/ios/Sources/Generated/futo_notes_ffi.swift',
  'apps/ios/FutoNotesFfi.xcframework/Info.plist',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64/Headers/module.modulemap',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64/Headers/futo_notes_ffiFFI.h',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64/libfuto_notes_ffi.a',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64_x86_64-simulator/libfuto_notes_ffi.a',
];

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fileDigest(path) {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

export function sourceProvenance(root) {
  const paths = git(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ...inputs,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  const files = paths.map((path) => ({ path, sha256: fileDigest(join(root, path)) }));
  return {
    sourceSHA: git(root, ['rev-parse', 'HEAD']),
    dirtyStatus: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    sourceFingerprint: digest(JSON.stringify(files)),
    files,
  };
}

export function ffiArtifacts(root) {
  return ffiArtifactPaths.map((path) => ({ path, sha256: fileDigest(join(root, path)) }));
}

export function assertBuildIdentity(root, provenance) {
  const current = sourceProvenance(root);
  if (
    provenance.sourceSHA !== current.sourceSHA ||
    provenance.sourceFingerprint !== current.sourceFingerprint
  )
    throw new Error('Fixture source differs from build provenance; rebuild first');
  if (JSON.stringify(provenance.artifacts) !== JSON.stringify(ffiArtifacts(root)))
    throw new Error('Fixture FFI artifact differs from build provenance; rebuild first');
}

export function assertFixtureSimulator(
  root,
  selected,
  { inspect = findSim, owner = readOwner } = {},
) {
  if (!selected) throw new Error('Set SIM to this worktree’s explicitly claimed simulator');
  for (let index = 0; index < POOL; index++) {
    const name = `futo-qa-${index}`;
    const claim = owner('ios', name);
    if (claim?.worktree !== root || claim.id !== selected || claim.wipePending) continue;
    const sim = inspect(name);
    if (sim?.udid === selected && sim.name === name && sim.state === 'Booted') return selected;
  }
  throw new Error(
    'Fixture unit tests require an existing booted QA pool simulator owned by this worktree',
  );
}

function testSimulator(root) {
  const selected = assertFixtureSimulator(root, process.env.SIM);
  const fixture = join(root, 'apps/ios/FixtureCapture');
  const provenance = JSON.parse(
    readFileSync(join(fixture, 'Generated/build-provenance.json'), 'utf8'),
  );
  assertBuildIdentity(root, provenance);
  assertFixtureSimulator(root, selected);
  const result = execFileSync(
    'xcodebuild',
    [
      'test',
      '-project',
      'Editor294Fixture.xcodeproj',
      '-scheme',
      'Editor294Fixture',
      '-only-testing:Editor294FixtureTests',
      '-configuration',
      'Debug',
      '-destination',
      `platform=iOS Simulator,id=${selected}`,
      '-derivedDataPath',
      '.build-native',
      '-collect-test-diagnostics',
      'never',
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=',
    ],
    { cwd: fixture, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  process.stdout.write(result);
  if (!/Test run with [1-9][0-9]* tests?/.test(result))
    throw new Error('No fixture tests executed');
  assertFixtureSimulator(root, selected);
}

function build(root) {
  const run = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  const before = sourceProvenance(root);
  run('just', ['build-rust-ios'], { env: { ...process.env, FUTO_IOS_FFI_PROFILE: 'release-ffi' } });
  const after = sourceProvenance(root);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Fixture source changed during FFI build; refusing provenance');
  const artifacts = ffiArtifacts(root);
  const tool = (command, args) =>
    execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
  const provenance = {
    ...after,
    artifacts,
    rustProfile: 'release-ffi',
    fixtureConfiguration: 'Debug',
    bundleID: 'org.futo.fixture.editor294',
    signed: false,
    rustc: tool('rustc', ['--version']),
    swift: tool('xcrun', ['swift', '--version']),
    xcode: tool('xcodebuild', ['-version']),
    builtAt: new Date().toISOString(),
  };
  const fixture = join(root, 'apps/ios/FixtureCapture');
  mkdirSync(join(fixture, 'Generated'), { recursive: true });
  writeFileSync(
    join(fixture, 'Generated/build-provenance.json'),
    JSON.stringify(provenance, null, 2) + '\n',
  );
  run('xcodegen', ['generate', '--spec', 'project.yml'], { cwd: fixture });
  const common = [
    '-project',
    'Editor294Fixture.xcodeproj',
    '-scheme',
    'Editor294Fixture',
    '-configuration',
    'Debug',
    '-derivedDataPath',
    '.build-native',
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
  ];
  run(
    'xcodebuild',
    [...common, '-destination', 'generic/platform=iOS Simulator', 'build-for-testing'],
    { cwd: fixture },
  );
  run('xcodebuild', [...common, '-destination', 'generic/platform=iOS', 'build-for-testing'], {
    cwd: fixture,
  });
  if (JSON.stringify(after) !== JSON.stringify(sourceProvenance(root)))
    throw new Error('Fixture source changed during native build');
  console.log(
    `Unsigned fixture built; source ${after.sourceSHA}; fingerprint ${after.sourceFingerprint}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (process.argv.length === 3 && process.argv[2] === '--test-simulator') testSimulator(root);
  else if (process.argv.length === 2) build(root);
  else throw new Error('Only compile-only mode or --test-simulator is supported');
}
