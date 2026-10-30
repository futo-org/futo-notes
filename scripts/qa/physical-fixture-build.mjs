// Signed UUID products only. Verify originals again before pinning and both
// originals and the private copy before every install or XCTest invocation.
import { join } from 'node:path';
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import {
  createEvidenceDirectory,
  writeEvidence,
  assertPrivateTree,
} from './physical-fixture-evidence.mjs';
import { fixtureFile, inspectSignedFixture } from './physical-fixture-signed.mjs';
const appID = 'org.futo.fixture.editor294';
const runnerID = `${appID}.uitests.xctrunner`;
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

function copyProduct(source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    createEvidenceDirectory(destination);
    for (const name of readdirSync(source))
      copyProduct(join(source, name), join(destination, name));
  } else if (stat.isFile()) {
    writeEvidence(destination, fixtureFile(source), { exclusive: true });
    if (stat.mode & 0o111) chmodSync(destination, 0o700);
  } else throw new Error('Unsupported signed fixture product');
}
export function createFixtureBuilds(root, providers) {
  const verified = new WeakMap();
  const pinned = new WeakMap();
  const inspect = (plan, options) => {
    const build = inspectSignedFixture(root, plan, providers, options);
    const candidates = readdirSync(build.products).filter((name) =>
      /^Editor294Fixture_iphoneos[^/]*\.xctestrun$/.test(name),
    );
    if (candidates.length !== 1)
      throw new Error('Exactly one physical fixture XCTest build is required');
    build.testRunPath = join(build.products, candidates[0]);
    build.xctestrun = providers.plist(build.testRunPath);
    fixedUITarget(build.xctestrun);
    // The plist provider is an OS boundary too; revalidate its input after it returns.
    const after = inspectSignedFixture(root, plan, providers, options);
    if (JSON.stringify(after.identity) !== JSON.stringify(build.identity))
      throw new Error('Signed fixture changed during XCTest verification');
    return build;
  };
  const unchanged = (before, after) => {
    if (
      before.buildFingerprint !== after.buildFingerprint ||
      JSON.stringify(before.identity) !== JSON.stringify(after.identity)
    )
      throw new Error('Signed fixture identity changed; no installation or input');
  };
  return {
    inspectBuild(plan) {
      const build = inspect(plan);
      verified.set(build, { plan: JSON.stringify(plan), build: JSON.stringify(build) });
      return build;
    },
    pinBuild(plan, build, output) {
      const selected = verified.get(build);
      if (
        !selected ||
        selected.plan !== JSON.stringify(plan) ||
        selected.build !== JSON.stringify(build)
      )
        throw new Error('Verified signed fixture plan required');
      assertPrivateTree(output);
      unchanged(build, inspect(plan));
      const pinnedRoot = join(output, 'pinned-products');
      createEvidenceDirectory(pinnedRoot);
      const products = join(pinnedRoot, 'Products');
      copyProduct(build.products, products);
      unchanged(build, inspect(plan));
      const snapshot = inspect(plan, { products });
      if (snapshot.buildFingerprint !== build.buildFingerprint)
        throw new Error('Fixture artifacts changed while pinning; no installation');
      pinned.set(snapshot, {
        plan: selected.plan,
        build: JSON.stringify(snapshot),
        output,
        products,
        app: snapshot.app,
        runner: snapshot.runner,
      });
      return snapshot;
    },
    pinnedPaths(build, output, plan) {
      const owned = pinned.get(build);
      if (
        !owned ||
        owned.output !== output ||
        owned.plan !== JSON.stringify(plan) ||
        owned.build !== JSON.stringify(build)
      )
        throw new Error('Verified private signed fixture snapshot required');
      assertPrivateTree(output);
      unchanged(build, inspect(plan, { products: owned.products }));
      return { output, products: owned.products, app: owned.app, runner: owned.runner };
    },
  };
}
