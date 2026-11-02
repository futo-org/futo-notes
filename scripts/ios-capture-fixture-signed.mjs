#!/usr/bin/env node
// Explicit standalone development-signing preparation only. Existing approved
// profile/identity, fixed fixture IDs; no provisioning, phone or network commands.
import { isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';
import * as yaml from 'js-yaml';
import { sourceProvenance, ffiArtifacts, assertBuildIdentity } from './ios-capture-fixture.mjs';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const bundleIDs = [
  'org.futo.fixture.editor294.tests',
  'org.futo.fixture.editor294',
  'org.futo.fixture.editor294.uitests',
  'org.futo.fixture.editor294.uitests.xctrunner',
];
export function validateSigningSelectionShape(selection) {
  const fields = {
    formatVersion: (v) => v === 1,
    sourceSHA: (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v),
    sourceFingerprint: (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    runID: (v) => typeof v === 'string' && /^[A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12}$/.test(v),
    deviceUDID: (v) => typeof v === 'string' && /^[A-F0-9]{8}-[A-F0-9]{16}$/.test(v),
    identitySHA1: (v) => typeof v === 'string' && /^[A-F0-9]{40}$/.test(v),
    teamID: (v) => typeof v === 'string' && /^[A-Z0-9]{10}$/.test(v),
    profileUUID: (v) =>
      typeof v === 'string' && /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(v),
    profileSHA256: (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    profilePath: (v) => typeof v === 'string' && isAbsolute(v) && v.endsWith('.mobileprovision'),
  };
  if (
    !selection ||
    Array.isArray(selection) ||
    typeof selection !== 'object' ||
    Object.keys(selection).length !== Object.keys(fields).length ||
    !Object.entries(fields).every(
      ([key, check]) => Object.hasOwn(selection, key) && check(selection[key]),
    )
  )
    throw new Error('Invalid explicit fixture signing selection');
}

export function validateSigningSelection(selection, profile, now = new Date()) {
  validateSigningSelectionShape(selection);
  const team = selection.teamID;
  const allowedEntitlements = new Set([
    'application-identifier',
    'com.apple.developer.team-identifier',
    'get-task-allow',
    'keychain-access-groups',
  ]);
  if (
    !profile?.Entitlements ||
    Object.keys(profile.Entitlements).some((key) => !allowedEntitlements.has(key))
  )
    throw new Error('Unsupported existing profile entitlements');
  if (
    profile?.UUID !== selection.profileUUID ||
    !Array.isArray(profile.Platform) ||
    !profile.Platform.includes('iOS') ||
    JSON.stringify(profile.TeamIdentifier) !== JSON.stringify([team]) ||
    JSON.stringify(profile.ApplicationIdentifierPrefix) !== JSON.stringify([team]) ||
    typeof profile.ExpirationDate !== 'string' ||
    !Number.isFinite(Date.parse(profile.ExpirationDate)) ||
    Date.parse(profile.ExpirationDate) <= now.getTime() ||
    !Array.isArray(profile.ProvisionedDevices) ||
    !profile.ProvisionedDevices.includes(selection.deviceUDID) ||
    !Array.isArray(profile.DeveloperCertificates) ||
    !profile.DeveloperCertificates.includes(selection.identitySHA1) ||
    profile.Entitlements?.['application-identifier'] !== `${team}.*` ||
    profile.Entitlements?.['com.apple.developer.team-identifier'] !== team ||
    profile.Entitlements?.['get-task-allow'] !== true
  )
    throw new Error(
      'Existing development profile does not match the fixed fixture signing selection',
    );
  return { teamID: team, prefix: team };
}

function regularBytes(path) {
  if (realpathSync(path) !== path) throw new Error('Fixture input aliases are forbidden');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid())
      throw new Error('Fixture input must be an owned regular file without hardlinks');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function snapshot(path, prefix = '') {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('Signed fixture aliases are forbidden');
  if (stat.isFile()) return [{ path: prefix, sha256: hash(regularBytes(path)) }];
  if (!stat.isDirectory()) throw new Error('Unsupported signed fixture product');
  return readdirSync(path)
    .sort()
    .flatMap((name) => snapshot(join(path, name), `${prefix}/${name}`));
}
const write = (path, value) => writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
const systemCommand = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const decodePlist = (bytes, command) =>
  JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: bytes }));

export function decodeSigningProfile(profileBytes, command) {
  const cms = command('/usr/bin/security', ['cms', '-D'], { input: profileBytes });
  const decoded = JSON.parse(
    command(
      '/usr/bin/python3',
      [
        '-c',
        'import sys,plistlib,json,datetime,base64; p=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps(p,default=lambda x: x.isoformat()+"Z" if isinstance(x,datetime.datetime) else base64.b64encode(x).decode("ascii")))',
      ],
      { input: cms },
    ),
  );
  return {
    ...decoded,
    DeveloperCertificates: decoded.DeveloperCertificates?.map((der) =>
      hash(Buffer.from(der, 'base64'), 'sha1').toUpperCase(),
    ),
  };
}

function signAndVerifyFixture({
  output,
  provenancePath,
  selection,
  profileBytes,
  profile,
  command,
  run,
  now,
}) {
  const products = join(output, 'DerivedData/Build/Products/Debug-iphoneos');
  const app = join(products, 'Editor294Fixture.app');
  const runner = join(products, 'Editor294FixtureUITests-Runner.app');
  if (
    readFileSync(join(app, 'build-provenance.json'), 'utf8') !==
    readFileSync(provenancePath, 'utf8')
  )
    throw new Error('Bundled signing request differs');
  const bundles = [
    join(app, 'PlugIns/Editor294FixtureTests.xctest'),
    app,
    join(runner, 'PlugIns/Editor294FixtureUITests.xctest'),
    runner,
  ];
  for (const [index, path] of bundles.entries()) {
    const info = decodePlist(regularBytes(join(path, 'Info.plist')), command);
    if (info.CFBundleIdentifier !== bundleIDs[index])
      throw new Error('Compiled fixture bundle identity differs');
  }
  snapshot(products); // Reject aliases and unsupported product nodes before signing.
  const signatures = [];
  for (const [index, path] of bundles.entries()) {
    const identifier = bundleIDs[index];
    const entitlements = {
      'application-identifier': `${selection.teamID}.${identifier}`,
      'com.apple.developer.team-identifier': selection.teamID,
      'get-task-allow': true,
    };
    const entitlementPath = join(output, `entitlements-${index}.json`);
    write(entitlementPath, JSON.stringify(entitlements));
    const xml = run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', entitlementPath]);
    const xmlPath = join(output, `entitlements-${index}.plist`);
    write(xmlPath, xml);
    write(join(path, 'embedded.mobileprovision'), profileBytes);
    if (hash(regularBytes(selection.profilePath)) !== selection.profileSHA256)
      throw new Error('Approved profile changed before signing');
    validateSigningSelection(selection, profile, now());
    run('/usr/bin/codesign', [
      '--force',
      '--sign',
      selection.identitySHA1,
      '--timestamp=none',
      // XCTest executables are Mach-O bundles; macOS 15 omits library entitlements by default.
      ...(path.endsWith('.xctest') ? ['--force-library-entitlements'] : []),
      '--entitlements',
      xmlPath,
      path,
    ]);
  }
  const signedArtifacts = snapshot(join(output, 'DerivedData/Build/Products'));
  for (const [index, path] of bundles.entries()) {
    run('/usr/bin/codesign', ['--verify', '--strict', '--deep', path]);
    const certPrefix = join(output, `certificate-${index}-`);
    run('/usr/bin/codesign', ['--display', `--extract-certificates=${certPrefix}`, path]);
    if (hash(regularBytes(`${certPrefix}0`), 'sha1').toUpperCase() !== selection.identitySHA1)
      throw new Error('Actual signing certificate differs');
    const actual = decodePlist(
      run('/usr/bin/codesign', ['--display', '--entitlements', ':-', path]),
      command,
    );
    const expected = {
      'application-identifier': `${selection.teamID}.${bundleIDs[index]}`,
      'com.apple.developer.team-identifier': selection.teamID,
      'get-task-allow': true,
    };
    if (
      JSON.stringify(Object.entries(actual).sort()) !==
      JSON.stringify(Object.entries(expected).sort())
    )
      throw new Error('Actual signed entitlements differ');
    if (hash(regularBytes(join(path, 'embedded.mobileprovision'))) !== selection.profileSHA256)
      throw new Error('Embedded profile differs');
    signatures.push({
      bundleID: bundleIDs[index],
      certificateSHA1: selection.identitySHA1,
      entitlements: actual,
    });
  }
  validateSigningSelection(selection, profile, now());
  if (
    JSON.stringify(snapshot(join(output, 'DerivedData/Build/Products'))) !==
    JSON.stringify(signedArtifacts)
  )
    throw new Error('Signed fixture products changed during verification');
  return { signatures, signedArtifacts };
}

export function buildSignedFixture(
  root,
  selection,
  { command = systemCommand, now = () => new Date() } = {},
) {
  validateSigningSelectionShape(selection);
  if (realpathSync(root) !== root) throw new Error('Canonical fixture checkout required');
  const source = sourceProvenance(root);
  if (
    source.sourceSHA !== selection.sourceSHA ||
    source.sourceFingerprint !== selection.sourceFingerprint ||
    source.dirtyStatus
  )
    throw new Error('Approved clean fixture source differs');
  const profileBytes = regularBytes(selection.profilePath);
  if (hash(profileBytes) !== selection.profileSHA256)
    throw new Error('Approved profile bytes differ');
  const profile = decodeSigningProfile(profileBytes, command);
  validateSigningSelection(selection, profile, now());
  if (hash(regularBytes(selection.profilePath)) !== selection.profileSHA256)
    throw new Error('Profile changed during decoding');
  const fixture = join(root, 'apps/ios/FixtureCapture');
  const base = join(fixture, '.build-signed');
  if (realpathSync(fixture) !== fixture) throw new Error('Canonical fixture owner required');
  try {
    mkdirSync(base, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (
    realpathSync(base) !== base ||
    !lstatSync(base).isDirectory() ||
    lstatSync(base).uid !== process.getuid() ||
    lstatSync(base).mode & 0o077
  )
    throw new Error('Private signed fixture output owner required');
  const output = join(base, selection.runID);
  mkdirSync(output, { mode: 0o700 }); // Exclusive run directory; retained on failure.
  write(join(output, 'selection.json'), JSON.stringify(selection, null, 2) + '\n');
  const run = (program, args, options = {}) => command(program, args, { cwd: root, ...options });
  run('just', ['build-rust-ios'], {
    env: { ...process.env, FUTO_IOS_FFI_PROFILE: 'release-ffi', CARGO_NET_OFFLINE: 'true' },
  });
  const assertFrozenSource = () => {
    if (JSON.stringify(sourceProvenance(root)) !== JSON.stringify(source))
      throw new Error('Fixture source changed from approved clean source');
  };
  assertFrozenSource();
  const provenance = {
    ...source,
    artifacts: ffiArtifacts(root),
    rustProfile: 'release-ffi',
    fixtureConfiguration: 'Debug',
    bundleID: bundleIDs[1],
    signed: false,
    signingStatus: 'development-signing-requested-not-verified',
    signingRequest: {
      identitySHA1: selection.identitySHA1,
      teamID: selection.teamID,
      profileUUID: selection.profileUUID,
      profileSHA256: selection.profileSHA256,
    },
    builtAt: now().toISOString(),
  };
  const provenancePath = join(output, 'build-provenance.json');
  write(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  const spec = yaml.load(readFileSync(join(fixture, 'project.yml'), 'utf8'));
  for (const target of Object.values(spec.targets)) {
    target.sources = target.sources.map((source) => ({
      ...source,
      path:
        source.path === 'Generated/build-provenance.json'
          ? provenancePath
          : resolve(fixture, source.path),
    }));
    for (const dependency of target.dependencies ?? [])
      if (dependency.framework) dependency.framework = resolve(fixture, dependency.framework);
  }
  const specPath = join(output, 'project.json');
  write(specPath, JSON.stringify(spec, null, 2) + '\n');
  run('xcodegen', ['generate', '--spec', specPath, '--project', output]);
  run('xcodebuild', [
    '-project',
    join(output, 'Editor294Fixture.xcodeproj'),
    '-scheme',
    'Editor294Fixture',
    '-configuration',
    'Debug',
    '-derivedDataPath',
    join(output, 'DerivedData'),
    '-destination',
    'generic/platform=iOS',
    '-disableAutomaticPackageResolution',
    '-skipPackageUpdates',
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
    'build-for-testing',
  ]);
  assertFrozenSource();
  assertBuildIdentity(root, provenance);
  const { signatures, signedArtifacts } = signAndVerifyFixture({
    output,
    provenancePath,
    selection,
    profileBytes,
    profile,
    command,
    run,
    now,
  });
  assertFrozenSource();
  assertBuildIdentity(root, provenance);
  const receipt = {
    kind: 'VERIFIED_SIGNED_ISOLATED_FIXTURE',
    sourceSHA: source.sourceSHA,
    sourceFingerprint: source.sourceFingerprint,
    provenance,
    signatures,
    artifacts: signedArtifacts,
    verifiedAt: now().toISOString(),
    physicalActions: false,
  };
  write(join(output, 'verified-signing-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { output, receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--selection')
    throw new Error('Expected only --selection <approved-private-file>');
  const selection = JSON.parse(regularBytes(resolve(process.argv[3])).toString('utf8'));
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  process.stdout.write(JSON.stringify(buildSignedFixture(root, selection)) + '\n');
}
