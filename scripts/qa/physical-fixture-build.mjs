// Verified compiled inputs and private per-run snapshots for the fixed iOS
// fixture. The executor receives only builds verified by this owner.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertPrivateTree,
  createEvidenceDirectory,
  writeEvidence,
} from './physical-fixture-evidence.mjs';
import { assertBuildIdentity, sourceProvenance } from '../ios-capture-fixture.mjs';
const appID = 'org.futo.fixture.editor294';
const runnerID = `${appID}.uitests.xctrunner`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));

function sourceBytes(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Unsupported fixture artifact');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function copyProduct(source, destination) {
  if (realpathSync(source) !== source || lstatSync(source).isSymbolicLink())
    throw new Error('Fixture artifacts must not contain aliases or symlinks');
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    createEvidenceDirectory(destination);
    for (const name of readdirSync(source))
      copyProduct(join(source, name), join(destination, name));
  } else if (stat.isFile()) {
    writeEvidence(destination, sourceBytes(source), { exclusive: true });
    // Executability is retained without granting group/other access.
    if (stat.mode & 0o111) chmodSync(destination, 0o700);
  } else throw new Error('Unsupported fixture artifact');
}

function files(path, prefix = '') {
  if (lstatSync(path).isSymbolicLink())
    throw new Error('Fixture artifacts must not contain symlinks');
  if (lstatSync(path).isFile()) return [{ path: prefix, sha256: hash(sourceBytes(path)) }];
  if (!lstatSync(path).isDirectory()) throw new Error('Unsupported fixture artifact');
  return readdirSync(path)
    .sort()
    .flatMap((name) => files(join(path, name), `${prefix}/${name}`));
}

export function fixedUITarget(xctestrun) {
  const target = xctestrun?.Editor294FixtureUITests;
  if (
    xctestrun?.__xctestrun_metadata__?.FormatVersion !== 1 ||
    target?.IsUITestBundle !== true ||
    (Object.hasOwn(target, 'UITargetAppBundleIdentifier') &&
      target.UITargetAppBundleIdentifier !== appID) ||
    target.TestHostBundleIdentifier !== runnerID ||
    target.TestHostPath !== '__TESTROOT__/Debug-iphoneos/Editor294FixtureUITests-Runner.app' ||
    target.UITargetAppPath !== '__TESTROOT__/Debug-iphoneos/Editor294Fixture.app' ||
    target.TestBundlePath !== '__TESTHOST__/PlugIns/Editor294FixtureUITests.xctest'
  )
    throw new Error('XCTest build does not name only the fixed physical fixture and runner');
  return target;
}

function inspectFixtureBuild(root, { fixture, products, app, runner }, { run, plist, runCommand }) {
  const provenance = readJSON(join(fixture, 'Generated/build-provenance.json'));
  assertBuildIdentity(root, provenance);
  const appProvenance = readJSON(join(app, 'build-provenance.json'));
  if (JSON.stringify(appProvenance) !== JSON.stringify(provenance))
    throw new Error('Bundled fixture provenance differs');
  const candidates = readdirSync(products).filter((name) =>
    /^Editor294Fixture_iphoneos[^/]*\.xctestrun$/.test(name),
  );
  if (candidates.length !== 1)
    throw new Error('Exactly one physical fixture XCTest build is required');
  const testRunPath = join(products, candidates[0]);
  const xctestrun = plist(testRunPath);
  fixedUITarget(xctestrun);
  if (
    plist(join(app, 'Info.plist')).CFBundleIdentifier !== appID ||
    plist(join(runner, 'Info.plist')).CFBundleIdentifier !== runnerID
  )
    throw new Error('Built fixture or runner bundle identity differs');
  const artifactSnapshot = () => ({
    app: files(app),
    runner: files(runner),
    xctestrun: hash(sourceBytes(testRunPath)),
    provenance: hash(JSON.stringify(provenance)),
  });
  const artifacts = artifactSnapshot();
  // Verification reads compiled signatures only. It cannot provision, sign,
  // update a profile or inspect keychains. Unsigned/ad-hoc builds refuse here,
  // before any device command. Availability is separate from authorization.
  for (const path of [app, runner]) {
    run('codesign', ['--verify', '--strict', '--deep', path]);
    const signature = runCommand('codesign', ['--display', '--verbose=4', path], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (
      signature.error ||
      signature.status !== 0 ||
      !/^Authority=/m.test(signature.stderr ?? '') ||
      /^Signature=adhoc$/m.test(signature.stderr ?? '')
    )
      throw new Error('A separately authorized signed fixture build is unavailable');
  }
  assertBuildIdentity(root, provenance);
  if (JSON.stringify(artifactSnapshot()) !== JSON.stringify(artifacts))
    throw new Error('Compiled fixture artifacts changed during verification');
  const source = sourceProvenance(root);
  return {
    sourceSHA: source.sourceSHA,
    sourceFingerprint: source.sourceFingerprint,
    buildFingerprint: hash(JSON.stringify(artifacts)),
    provenance,
    artifacts,
    xctestrun,
    products,
    testRunPath,
  };
}

export function createFixtureBuilds(root, { run, plist, runCommand }) {
  const verifiedBuilds = new WeakSet();
  const pinnedBuilds = new WeakMap();
  const fixture = join(root, 'apps/ios/FixtureCapture');
  const products = join(fixture, '.build-native/Build/Products');
  const app = join(products, 'Debug-iphoneos/Editor294Fixture.app');
  const runner = join(products, 'Debug-iphoneos/Editor294FixtureUITests-Runner.app');
  function pinnedPaths(build, output) {
    const pinned = pinnedBuilds.get(build);
    if (!pinned || pinned.output !== output)
      throw new Error('Verified private fixture snapshot required');
    assertPrivateTree(output);
    const artifacts = {
      app: files(pinned.app),
      runner: files(pinned.runner),
      xctestrun: hash(sourceBytes(build.testRunPath)),
      provenance: hash(JSON.stringify(build.provenance)),
    };
    if (hash(JSON.stringify(artifacts)) !== build.buildFingerprint)
      throw new Error('Pinned fixture artifacts changed; no installation or input');
    assertBuildIdentity(root, build.provenance);
    return pinned;
  }
  return {
    pinnedPaths,
    inspectBuild() {
      const build = inspectFixtureBuild(
        root,
        { fixture, products, app, runner },
        { run, plist, runCommand },
      );
      verifiedBuilds.add(build);
      return build;
    },
    pinBuild(_plan, build, output) {
      if (!verifiedBuilds.has(build)) throw new Error('Verified fixture build required');
      assertPrivateTree(output);
      assertBuildIdentity(root, build.provenance);
      const pinnedRoot = join(output, 'pinned-products');
      createEvidenceDirectory(pinnedRoot);
      const pinnedProducts = join(pinnedRoot, 'Products');
      createEvidenceDirectory(pinnedProducts);
      const configuration = join(pinnedProducts, 'Debug-iphoneos');
      createEvidenceDirectory(configuration);
      const pinnedApp = join(configuration, 'Editor294Fixture.app');
      const pinnedRunner = join(configuration, 'Editor294FixtureUITests-Runner.app');
      copyProduct(app, pinnedApp);
      copyProduct(runner, pinnedRunner);
      copyProduct(build.testRunPath, join(pinnedProducts, 'Editor294Fixture_iphoneos.xctestrun'));
      const snapshot = inspectFixtureBuild(
        root,
        { fixture, products: pinnedProducts, app: pinnedApp, runner: pinnedRunner },
        { run, plist, runCommand },
      );
      if (snapshot.buildFingerprint !== build.buildFingerprint)
        throw new Error('Fixture artifacts changed while pinning; no installation');
      pinnedBuilds.set(snapshot, {
        output,
        products: pinnedProducts,
        app: pinnedApp,
        runner: pinnedRunner,
      });
      return snapshot;
    },
  };
}
