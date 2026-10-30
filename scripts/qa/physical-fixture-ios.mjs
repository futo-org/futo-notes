// The only OS adapter for the physical #294 Puppet capability. Every command,
// bundle, test and container path is fixed here; manifests supply identities,
// never programs, arguments, XCTest filters, launch code, or filesystem paths.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import {
  assertPrivateTree,
  assertEvidenceAbsent,
  evidenceHashes,
  readEvidenceJSON,
  readEvidence,
  writeEvidenceJSON,
} from './physical-fixture-evidence.mjs';
import { isFixtureRunID, validateFixtureResult } from './physical-fixture-contract.mjs';
import { fixtureFile } from './physical-fixture-signed.mjs';
import { createFixtureBuilds, fixedUITarget } from './physical-fixture-build.mjs';

const appID = 'org.futo.fixture.editor294';
const runnerID = `${appID}.uitests.xctrunner`;
const testID = 'DictationCaptureTests/testCapture';
const save = (path, value) => writeEvidenceJSON(path, value, { exclusive: true });

async function captureScenario(plan, build, output, { products, runner, run, beforeUse }) {
  assertPrivateTree(output);
  for (const name of [
    'capture.xctestrun',
    'capture.xcresult',
    'xctest-command.json',
    'xctest-summary.json',
    'attachments',
    'xctest-evidence-hashes.json',
  ])
    assertEvidenceAbsent(join(output, name));
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
  beforeUse();
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
  assertPrivateTree(output);
  const attachmentManifest = readEvidenceJSON(join(output, 'attachments/manifest.json'));
  if (
    !Array.isArray(attachmentManifest) ||
    attachmentManifest.some((item) => !Array.isArray(item.attachments))
  )
    throw new Error('Malformed XCTest attachment manifest');
  const attachments = attachmentManifest
    .filter((item) => item.testIdentifier === `${testID}()`)
    .flatMap((item) => item.attachments)
    .filter(
      (item) =>
        item.suggestedHumanReadableName === 'editor294-gesture.json' &&
        item.deviceId === plan.deviceUDID,
    );
  if (
    attachments.length !== 1 ||
    typeof attachments[0].exportedFileName !== 'string' ||
    ['.', '..'].includes(attachments[0].exportedFileName) ||
    !/^[^/\\]+$/.test(attachments[0].exportedFileName)
  )
    throw new Error('Fixed XCTest gesture attachment is missing or ambiguous');
  const gesture = readEvidenceJSON(join(output, 'attachments', attachments[0].exportedFileName));
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
    result: evidenceHashes(resultPath),
    attachments: evidenceHashes(join(output, 'attachments')),
  });
  const result = {
    totalTestCount: summary.totalTestCount,
    passedTests: summary.passedTests,
    failedTests: summary.failedTests,
    skippedTests: summary.skippedTests,
    deviceUDID: destinations[0].device.deviceId,
    testIdentifier: testID,
    gesture,
  };
  validateFixtureResult(plan, result);
  return result;
}

function inspectPhysicalDevice(plan, deviceJSON, appInventory) {
  const details = deviceJSON(plan, ['info', 'details', '--omit-deprecated-fields-in-json']);
  const device = details.result?.device ?? details.result;
  const lock = deviceJSON(plan, ['info', 'lockState']);
  const properties = device?.properties;
  if (
    device?.identifier !== plan.coreDeviceID ||
    properties?.hardware?.udid !== plan.deviceUDID ||
    properties?.hardware?.reality !== 'physical' ||
    properties?.hardware?.platform !== 'iOS' ||
    properties?.state?.bootState !== 'booted' ||
    properties?.connection?.pairingState !== 'paired' ||
    properties?.connection?.state !== 'connected' ||
    properties?.connection?.transportType !== 'wired' ||
    lock.result?.passcodeRequired !== false ||
    lock.result?.unlockedSinceBoot !== true
  )
    throw new Error('Physical fixture device details or lock schema differs or is unavailable');
  const inventories = [appInventory(plan, appID), appInventory(plan, runnerID)];
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
    unlocked: lock.result?.passcodeRequired === false && lock.result?.unlockedSinceBoot === true,
    installations: inventories.flatMap((inventory) => inventory.installations),
    raw: { details, lock, apps: inventories.map((inventory) => inventory.raw) },
  };
}

function fixtureCommands(root, runCommand) {
  return function run(command, args, { timeout = 20000, output, name, input } = {}) {
    let result;
    const mask = process.umask(0o077);
    try {
      result = runCommand(command, args, {
        cwd: root,
        encoding: 'utf8',
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        input,
        env: { ...process.env, NSUnbufferedIO: 'YES' },
      });
    } finally {
      process.umask(mask);
    }
    if (output) assertPrivateTree(output);
    if (output && name)
      save(join(output, name), {
        command,
        args,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string')
      throw new Error(`${command} failed or timed out: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
}

export function createIOSFixtureExecutor(root, { runCommand = spawnSync } = {}) {
  const run = fixtureCommands(root, runCommand);
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
    if (raw?.info?.outcome !== 'success') throw new Error('CoreDevice operation did not succeed');
    if (!args.includes('details') && raw.result?.deviceIdentifier !== plan.coreDeviceID)
      throw new Error('CoreDevice operation destination differs or is unknown');
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
      raw.result.apps.some(
        (a) =>
          a.bundleIdentifier !== bundleID ||
          typeof a.bundleVersion !== 'string' ||
          !a.bundleVersion ||
          typeof a.url !== 'string' ||
          !a.url,
      )
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
    assertPrivateTree(output);
    assertEvidenceAbsent(join(output, name));
    assertEvidenceAbsent(join(output, `${name}.inventory.json`));
    const raw = deviceJSON(plan, ['install', 'app', path], { output, name });
    const installed = raw.result?.installedApplications;
    if (!Array.isArray(installed) || installed.length !== 1 || installed[0].bundleID !== bundleID)
      throw new Error('CoreDevice install did not attest the fixed bundle identity');
    const inventory = appInventory(plan, bundleID);
    save(join(output, `${name}.inventory.json`), inventory.raw);
    if (inventory.installations.length !== 1) throw new Error('Fixture installation is ambiguous');
    return inventory.installations[0];
  }
  const { inspectBuild, pinBuild, pinnedPaths } = createFixtureBuilds(root, {
    run,
    plist,
    runCommand,
  });
  return {
    inspectBuild,
    pinBuild,
    inspectDevice: (plan) => inspectPhysicalDevice(plan, deviceJSON, appInventory),
    async installFixture(plan, build, output) {
      return install(
        plan,
        pinnedPaths(build, output, plan).app,
        appID,
        output,
        'install-fixture.json',
      );
    },
    async installRunner(plan, build, output) {
      return install(
        plan,
        pinnedPaths(build, output, plan).runner,
        runnerID,
        output,
        'install-runner.json',
      );
    },
    async capture(plan, build, output) {
      fixedUITarget(build.xctestrun);
      return captureScenario(plan, build, output, {
        ...pinnedPaths(build, output, plan),
        run,
        beforeUse: () => pinnedPaths(build, output, plan),
      });
    },
    copyArtifact(plan, output) {
      assertPrivateTree(output);
      const path = join(output, 'capture.raw.json');
      assertEvidenceAbsent(path);
      assertEvidenceAbsent(join(output, 'copy-artifact-command.json'));
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
      assertPrivateTree(output);
      return readEvidence(path);
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (
    process.argv.length !== 5 ||
    process.argv[2] !== '--identity' ||
    process.argv[3] !== '--run' ||
    !isFixtureRunID(process.argv[4])
  )
    throw new Error(
      'Only --identity --run <UUID> (local signed fixture verification; no device) is supported',
    );
  const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  const runID = process.argv[4];
  const selection = JSON.parse(
    fixtureFile(join(root, 'apps/ios/FixtureCapture/.build-signed', runID, 'selection.json')),
  );
  if (selection?.runID !== runID)
    throw new Error('Signed fixture selection differs from requested run');
  const build = createIOSFixtureExecutor(root).inspectBuild({ ...selection, runID });
  console.log(
    JSON.stringify({
      signing: build.signing,
      worktree: root,
      sourceSHA: build.sourceSHA,
      sourceFingerprint: build.sourceFingerprint,
      buildFingerprint: build.buildFingerprint,
      bundleID: appID,
      runnerBundleID: runnerID,
    }),
  );
}
