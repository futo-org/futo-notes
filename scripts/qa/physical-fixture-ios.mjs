// The only OS adapter for the physical #294 Puppet capability. Every command,
// bundle, test and container path is fixed here; manifests supply identities,
// never programs, arguments, XCTest filters, launch code, or filesystem paths.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { assertBuildIdentity, sourceProvenance } from '../ios-capture-fixture.mjs';

const appID = 'org.futo.fixture.editor294';
const runnerID = `${appID}.uitests.xctrunner`;
const testID = 'DictationCaptureTests/testCapture';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function files(path, prefix = '') {
  if (lstatSync(path).isSymbolicLink())
    throw new Error('Fixture artifacts must not contain symlinks');
  if (lstatSync(path).isFile()) return [{ path: prefix, sha256: hash(readFileSync(path)) }];
  if (!lstatSync(path).isDirectory()) throw new Error('Unsupported fixture artifact');
  return readdirSync(path)
    .sort()
    .flatMap((name) => files(join(path, name), `${prefix}/${name}`));
}

function fixedUITarget(xctestrun) {
  const target = xctestrun?.Editor294FixtureUITests;
  if (
    xctestrun?.__xctestrun_metadata__?.FormatVersion !== 1 ||
    target?.IsUITestBundle !== true ||
    target.UITargetAppBundleIdentifier !== appID ||
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
    xctestrun: hash(readFileSync(testRunPath)),
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
  };
}

async function captureScenario(plan, build, output, { products, runner, run }) {
  const target = fixedUITarget(build.xctestrun);
  const launch = {
    runID: plan.runID,
    nonce: plan.nonce,
    destination: plan.deviceUDID,
    seconds: plan.seconds,
  };
  const substitute = (value) => {
    if (typeof value === 'string')
      return value.replaceAll('__TESTROOT__', products).replaceAll('__TESTHOST__', runner);
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
    return value;
  };
  const fixed = substitute(target);
  fixed.EnvironmentVariables = {
    ...fixed.EnvironmentVariables,
    FUTO_EDITOR294_LAUNCH: JSON.stringify(launch),
  };
  fixed.OnlyTestIdentifiers = [testID];
  fixed.CommandLineArguments = [];
  fixed.TestTimeoutsEnabled = true;
  fixed.DefaultTestExecutionTimeAllowance = plan.seconds + 45;
  fixed.MaximumTestExecutionTimeAllowance = plan.seconds + 45;
  fixed.InProcessParallelizationEnabled = false;
  const runPath = join(output, 'capture.xctestrun');
  save(runPath, {
    Editor294FixtureUITests: fixed,
    __xctestrun_metadata__: build.xctestrun.__xctestrun_metadata__,
  });
  const resultPath = join(output, 'capture.xcresult');
  run(
    'xcodebuild',
    [
      'test-without-building',
      '-xctestrun',
      runPath,
      '-destination',
      `platform=iOS,id=${plan.deviceUDID}`,
      '-parallel-testing-enabled',
      'NO',
      '-only-testing:Editor294FixtureUITests/DictationCaptureTests/testCapture',
      '-resultBundlePath',
      resultPath,
      '-collect-test-diagnostics',
      'never',
    ],
    { timeout: (plan.seconds + 180) * 1000, output, name: 'xctest-command.json' },
  );
  const summary = JSON.parse(
    run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath]),
  );
  save(join(output, 'xctest-summary.json'), summary);
  run('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    resultPath,
    '--test-id',
    `${testID}()`,
    '--output-path',
    join(output, 'attachments'),
  ]);
  const attachmentManifest = readJSON(join(output, 'attachments/manifest.json'));
  const attachments = attachmentManifest
    .filter((item) => item.testIdentifier === `${testID}()`)
    .flatMap((item) => item.attachments)
    .filter(
      (item) =>
        item.suggestedHumanReadableName === 'editor294-gesture.json' &&
        item.deviceId === plan.deviceUDID,
    );
  if (attachments.length !== 1 || !/^[^/\\]+$/.test(attachments[0].exportedFileName))
    throw new Error('Fixed XCTest gesture attachment is missing or ambiguous');
  const gesture = readJSON(join(output, 'attachments', attachments[0].exportedFileName));
  const destinations = Array.isArray(summary.devicesAndConfigurations)
    ? summary.devicesAndConfigurations
    : [summary.devicesAndConfigurations];
  if (
    destinations.length !== 1 ||
    destinations[0]?.device?.deviceId !== plan.deviceUDID ||
    destinations[0].device.platform !== 'iOS'
  )
    throw new Error('Actual XCTest physical destination differs');
  save(join(output, 'xctest-evidence-hashes.json'), {
    result: files(resultPath),
    attachments: files(join(output, 'attachments')),
  });
  return {
    totalTestCount: summary.totalTestCount,
    passedTests: summary.passedTests,
    failedTests: summary.failedTests,
    skippedTests: summary.skippedTests,
    deviceUDID: destinations[0].device.deviceId,
    testIdentifier: testID,
    gesture,
  };
}

export function createIOSFixtureExecutor(root, { runCommand = spawnSync } = {}) {
  const fixture = join(root, 'apps/ios/FixtureCapture');
  const products = join(fixture, '.build-native/Build/Products');
  const app = join(products, 'Debug-iphoneos/Editor294Fixture.app');
  const runner = join(products, 'Debug-iphoneos/Editor294FixtureUITests-Runner.app');
  function run(command, args, { timeout = 20000, output, name } = {}) {
    const result = runCommand(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NSUnbufferedIO: 'YES' },
    });
    if (output && name)
      save(join(output, name), {
        command,
        args,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      });
    if (result.error || result.status !== 0)
      throw new Error(`${command} failed or timed out: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  }
  const plist = (path) => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path]));
  function deviceJSON(plan, args, options) {
    const raw = JSON.parse(
      run(
        'xcrun',
        [
          'devicectl',
          'device',
          ...args,
          '--device',
          plan.coreDeviceID,
          '--timeout',
          '15',
          '--json-output',
          '-',
        ],
        options,
      ),
    );
    if (raw.info?.outcome !== 'success') throw new Error('CoreDevice operation did not succeed');
    return raw;
  }
  function appInventory(plan, bundleID) {
    const raw = deviceJSON(plan, [
      'info',
      'apps',
      '--include-default-apps',
      '--bundle-id',
      bundleID,
    ]);
    if (
      raw.result?.deviceIdentifier !== plan.coreDeviceID ||
      !Array.isArray(raw.result.apps) ||
      raw.result.apps.some((a) => a.bundleIdentifier !== bundleID)
    )
      throw new Error('Installed bundle inventory destination or filter differs');
    return {
      raw,
      installations: raw.result.apps.map((a) => ({
        bundleID: a.bundleIdentifier,
        version: a.bundleVersion,
        url: a.url,
      })),
    };
  }
  function install(plan, path, bundleID, output, name) {
    const raw = deviceJSON(plan, ['install', 'app', path], { output, name });
    const installed = raw.result?.installedApplications;
    if (!Array.isArray(installed) || installed.length !== 1 || installed[0].bundleID !== bundleID)
      throw new Error('CoreDevice install did not attest the fixed bundle identity');
    const inventory = appInventory(plan, bundleID);
    save(join(output, `${name}.inventory.json`), inventory.raw);
    if (inventory.installations.length !== 1) throw new Error('Fixture installation is ambiguous');
    return inventory.installations[0];
  }
  return {
    inspectBuild: () =>
      inspectFixtureBuild(root, { fixture, products, app, runner }, { run, plist, runCommand }),
    inspectDevice(plan) {
      const details = deviceJSON(plan, ['info', 'details', '--omit-deprecated-fields-in-json']);
      const device = details.result?.device ?? details.result;
      const lock = deviceJSON(plan, ['info', 'lockState']);
      const inventories = [appInventory(plan, appID), appInventory(plan, runnerID)];
      const properties = device?.properties;
      return {
        deviceUDID: properties?.hardware?.udid,
        coreDeviceID: device?.identifier,
        physical:
          properties?.hardware?.reality === 'physical' && properties?.hardware?.platform === 'iOS',
        available:
          properties?.state?.bootState === 'booted' &&
          properties?.connection?.pairingState === 'paired' &&
          properties?.connection?.state === 'connected' &&
          properties?.connection?.transportType === 'wired',
        // Unknown lock-result shapes fail closed; first authorized device read
        // must retain the raw schema rather than infer unlocked from availability.
        unlocked:
          lock.result?.passcodeRequired === false && lock.result?.unlockedSinceBoot === true,
        installations: inventories.flatMap((inventory) => inventory.installations),
        raw: { details, lock, apps: inventories.map((inventory) => inventory.raw) },
      };
    },
    installFixture: (plan, _build, output) =>
      install(plan, app, appID, output, 'install-fixture.json'),
    installRunner: (plan, _build, output) =>
      install(plan, runner, runnerID, output, 'install-runner.json'),
    capture: (plan, build, output) =>
      captureScenario(plan, build, output, { products, runner, run }),
    copyArtifact(plan, output) {
      const path = join(output, 'capture.raw.json');
      deviceJSON(
        plan,
        [
          'copy',
          'from',
          '--domain-type',
          'appDataContainer',
          '--domain-identifier',
          appID,
          '--source',
          `tmp/editor294-${plan.runID}/capture.json`,
          '--destination',
          path,
        ],
        { output, name: 'copy-artifact-command.json' },
      );
      return readFileSync(path, 'utf8');
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--identity')
    throw new Error(
      'Only --identity (local compiled build/signature verification; no device) is supported',
    );
  const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  const build = createIOSFixtureExecutor(root).inspectBuild();
  console.log(
    JSON.stringify({
      worktree: root,
      sourceSHA: build.sourceSHA,
      sourceFingerprint: build.sourceFingerprint,
      buildFingerprint: build.buildFingerprint,
      bundleID: appID,
      runnerBundleID: runnerID,
    }),
  );
}
