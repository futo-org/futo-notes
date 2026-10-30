// Independent consumption of one fixed signed UUID output. This owner never
// signs, builds, provisions, chooses arbitrary products, or touches a device.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readdirSync,
  mkdtempSync,
} from 'node:fs';
import { sourceProvenance, assertBuildIdentity } from '../ios-capture-fixture.mjs';
import {
  validateSigningSelection,
  validateSigningSelectionShape,
  decodeSigningProfile,
} from '../ios-capture-fixture-signed.mjs';
import { isFixtureRunID } from './physical-fixture-contract.mjs';
import { assertPrivateDirectory } from './physical-fixture-evidence.mjs';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const statOf = (path) => lstatSync(path, { bigint: true });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value, fields) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  equal(Object.keys(value).sort(), [...fields].sort());
const IDs = [
  'org.futo.fixture.editor294.tests',
  'org.futo.fixture.editor294',
  'org.futo.fixture.editor294.uitests',
  'org.futo.fixture.editor294.uitests.xctrunner',
];
function assertRegularFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()))
    throw new Error('Signed fixture requires owned single-link regular files');
}
export function fixtureFile(path) {
  if (realpathSync(path) !== path) throw new Error('Signed fixture aliases are forbidden');
  const selected = statOf(path);
  assertRegularFile(selected);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    const entry = statOf(path);
    assertRegularFile(before);
    if (
      !equal(identity(selected), identity(before)) ||
      entry.dev !== before.dev ||
      entry.ino !== before.ino
    )
      throw new Error('Signed fixture file identity changed before read');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      !equal(identity(before), identity(after)) ||
      !equal(identity(after), identity(statOf(path)))
    )
      throw new Error('Signed fixture file identity changed during read');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function identity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map((value) => value.toString());
}
export function fixtureTree(path, prefix = '') {
  if (realpathSync(path) !== path) throw new Error('Signed fixture aliases are forbidden');
  const stat = statOf(path);
  if (stat.uid !== BigInt(process.getuid())) throw new Error('Signed fixture owner differs');
  if (stat.isFile()) return [{ path: prefix, sha256: hash(fixtureFile(path)) }];
  if (!stat.isDirectory()) throw new Error('Unsupported signed fixture product');
  return readdirSync(path)
    .sort()
    .flatMap((name) => fixtureTree(join(path, name), `${prefix}/${name}`));
}
function treeIdentity(path, prefix = '') {
  const stat = statOf(path);
  const current = { path: prefix, identity: identity(stat) };
  return stat.isDirectory()
    ? [
        current,
        ...readdirSync(path)
          .sort()
          .flatMap((name) => treeIdentity(join(path, name), `${prefix}/${name}`)),
      ]
    : [current];
}
function verifySignatures({ app, runner, receipt, selection, run, plist }) {
  const bundles = [
    join(app, 'PlugIns/Editor294FixtureTests.xctest'),
    app,
    join(runner, 'PlugIns/Editor294FixtureUITests.xctest'),
    runner,
  ];
  if (!Array.isArray(receipt.signatures) || receipt.signatures.length !== 4)
    throw new Error('Four signed fixture signatures required');
  // Fresh private extraction paths keep verification from mutating approved products.
  const certificates = mkdtempSync(join(realpathSync(tmpdir()), 'editor294-verify-'));
  for (const [index, path] of bundles.entries()) {
    if (plist(join(path, 'Info.plist')).CFBundleIdentifier !== IDs[index])
      throw new Error('Compiled fixture bundle identity differs');
    run('/usr/bin/codesign', ['--verify', '--strict', '--deep', path]);
    const prefix = join(certificates, `certificate-${index}-`);
    run('/usr/bin/codesign', ['--display', '--extract-certificates', prefix, path]);
    if (hash(fixtureFile(`${prefix}0`), 'sha1').toUpperCase() !== selection.identitySHA1)
      throw new Error('Actual signing certificate differs');
    const actual = JSON.parse(
      run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
        input: run('/usr/bin/codesign', ['--display', '--entitlements', ':-', path]),
      }),
    );
    const entitlements = {
      'application-identifier': `${selection.teamID}.${IDs[index]}`,
      'com.apple.developer.team-identifier': selection.teamID,
      'get-task-allow': true,
    };
    const matchesEntitlements = (value) =>
      exact(value, Object.keys(entitlements)) &&
      Object.entries(entitlements).every(([key, expected]) => value[key] === expected);
    const signature = receipt.signatures[index];
    if (
      !matchesEntitlements(actual) ||
      !exact(signature, ['bundleID', 'certificateSHA1', 'entitlements']) ||
      signature.bundleID !== IDs[index] ||
      signature.certificateSHA1 !== selection.identitySHA1 ||
      !matchesEntitlements(signature.entitlements) ||
      hash(fixtureFile(join(path, 'embedded.mobileprovision'))) !== selection.profileSHA256
    )
      throw new Error('Actual signed entitlements, profile or receipt differ');
  }
}

export function inspectSignedFixture(
  root,
  plan,
  { run, plist },
  { products: copiedProducts } = {},
) {
  if (!isFixtureRunID(plan?.runID)) throw new Error('Exact signed fixture run UUID required');
  const base = join(root, 'apps/ios/FixtureCapture/.build-signed');
  const output = join(base, plan.runID);
  assertPrivateDirectory(base);
  assertPrivateDirectory(output);
  const selectionPath = join(output, 'selection.json');
  const receiptPath = join(output, 'verified-signing-receipt.json');
  const provenancePath = join(output, 'build-provenance.json');
  const records = [];
  const boundJSON = (path) => {
    const stat = statOf(path);
    if ((stat.mode & 0o777n) !== 0o600n)
      throw new Error('Private signed fixture metadata required');
    const bytes = fixtureFile(path);
    if (!equal(identity(stat), identity(statOf(path))))
      throw new Error('Signed fixture metadata changed');
    records.push({ path, identity: identity(stat), sha256: hash(bytes) });
    return JSON.parse(bytes);
  };
  const selection = boundJSON(selectionPath);
  const receipt = boundJSON(receiptPath);
  const provenance = boundJSON(provenancePath);
  if (
    !exact(receipt, [
      'kind',
      'sourceSHA',
      'sourceFingerprint',
      'provenance',
      'signatures',
      'artifacts',
      'verifiedAt',
      'physicalActions',
    ]) ||
    receipt.kind !== 'VERIFIED_SIGNED_ISOLATED_FIXTURE' ||
    receipt.physicalActions !== false ||
    typeof receipt.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
    receipt.sourceSHA !== plan.sourceSHA ||
    receipt.sourceFingerprint !== plan.sourceFingerprint ||
    selection.runID !== plan.runID ||
    selection.deviceUDID !== plan.deviceUDID ||
    selection.sourceSHA !== plan.sourceSHA ||
    selection.sourceFingerprint !== plan.sourceFingerprint ||
    !equal(receipt.provenance, provenance)
  )
    throw new Error('Signed fixture receipt identity differs');
  validateSigningSelectionShape(selection);
  const originalProducts = join(output, 'DerivedData/Build/Products');
  const paths = [base, output, selectionPath, receiptPath, provenancePath, selection.profilePath];
  const stable = () => ({
    files: paths.map((path) => ({
      path,
      identity: identity(statOf(path)),
      ...(statOf(path).isFile() ? { sha256: hash(fixtureFile(path)) } : {}),
    })),
    products: treeIdentity(originalProducts),
    hashes: fixtureTree(originalProducts),
  });
  const before = stable();
  if (!records.every((record) => before.files.some((file) => equal(file, record))))
    throw new Error('Signed fixture metadata identity changed');
  if (!equal(before.hashes, receipt.artifacts))
    throw new Error('Signed fixture product hashes differ');
  const profileBytes = fixtureFile(selection.profilePath);
  if (hash(profileBytes) !== selection.profileSHA256)
    throw new Error('Approved profile bytes differ');
  const profile = decodeSigningProfile(profileBytes, run);
  validateSigningSelection(selection, profile);
  const current = sourceProvenance(root);
  const expectedProvenance = {
    ...current,
    artifacts: provenance.artifacts,
    rustProfile: 'release-ffi',
    fixtureConfiguration: 'Debug',
    bundleID: IDs[1],
    signed: false,
    signingStatus: 'development-signing-requested-not-verified',
    signingRequest: {
      identitySHA1: selection.identitySHA1,
      teamID: selection.teamID,
      profileUUID: selection.profileUUID,
      profileSHA256: selection.profileSHA256,
    },
    builtAt: provenance.builtAt,
  };
  if (
    current.sourceSHA !== plan.sourceSHA ||
    current.sourceFingerprint !== plan.sourceFingerprint ||
    current.dirtyStatus ||
    !equal(provenance, expectedProvenance) ||
    typeof provenance.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(provenance.builtAt))
  )
    throw new Error('Signed fixture clean source or bundled signing request differs');
  assertBuildIdentity(root, provenance);
  const products = copiedProducts ?? originalProducts;
  const app = join(products, 'Debug-iphoneos/Editor294Fixture.app');
  const runner = join(products, 'Debug-iphoneos/Editor294FixtureUITests-Runner.app');
  const localBefore = { hashes: fixtureTree(products), identities: treeIdentity(products) };
  if (!equal(localBefore.hashes, receipt.artifacts))
    throw new Error('Copied signed fixture hashes differ');
  if (!equal(JSON.parse(fixtureFile(join(app, 'build-provenance.json'))), provenance))
    throw new Error('Bundled fixture provenance differs');
  verifySignatures({ app, runner, receipt, selection, run, plist });
  validateSigningSelection(selection, profile);
  assertBuildIdentity(root, provenance);
  if (
    !equal(sourceProvenance(root), current) ||
    !equal(stable(), before) ||
    !equal({ hashes: fixtureTree(products), identities: treeIdentity(products) }, localBefore)
  )
    throw new Error('Signed fixture identity changed during verification');
  return {
    products,
    app,
    runner,
    provenance,
    sourceSHA: current.sourceSHA,
    sourceFingerprint: current.sourceFingerprint,
    artifacts: localBefore.hashes,
    signing: { status: 'independently-verified-signed-output', runID: plan.runID },
    buildFingerprint: hash(JSON.stringify({ receipt, selection, originalIdentity: before })),
    identity: { original: before, local: localBefore },
  };
}
