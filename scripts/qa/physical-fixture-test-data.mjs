// Disposable public-lifecycle test data. Only external device behavior is mocked.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease } from './physical-fixture-lease.mjs';
export const runID = '650D54CC-6339-4D62-B550-834BFBB8D7AA';
export const nonce = '9ADC97CB-1A3D-443E-B5C7-62E50B90CDF1';
export function setup(reserve = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'physical-capture-test-')));
  const plan = {
    formatVersion: 1,
    host: 'capture-host',
    deviceUDID: '00008150-001C70A634F0401C',
    coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
    worktree: directory,
    sourceSHA: 'a'.repeat(40),
    sourceFingerprint: 'b'.repeat(64),
    runID,
    nonce,
    ownerPID: 123,
    bundleID: 'org.futo.fixture.editor294',
    runnerBundleID: 'org.futo.fixture.editor294.uitests.xctrunner',
    seconds: 10,
    buildFingerprint: 'c'.repeat(64),
  };
  const effects = [];
  const installations = [];
  const leaseRuntime = {
    directory: join(directory, 'leases'),
    host: plan.host,
    processIdentity: () => 'same-live-process',
  };
  const runtime = {
    root: directory,
    host: plan.host,
    scratch: join(directory, 'runs'),
    leaseRuntime,
    executor: {
      pinBuild: (_plan, build) => build,
      inspectBuild: () => ({
        sourceSHA: plan.sourceSHA,
        sourceFingerprint: plan.sourceFingerprint,
        buildFingerprint: plan.buildFingerprint,
        provenance: { sourceSHA: plan.sourceSHA, sourceFingerprint: plan.sourceFingerprint },
      }),
      inspectDevice: () => ({
        deviceUDID: plan.deviceUDID,
        coreDeviceID: plan.coreDeviceID,
        physical: true,
        available: true,
        unlocked: true,
        installations: [...installations],
      }),
      installFixture: () => {
        effects.push('install-fixture');
        const installed = {
          bundleID: plan.bundleID,
          url: 'file:///owned-fixture.app',
          version: '1',
        };
        installations.push(installed);
        return installed;
      },
      installRunner: () => {
        effects.push('install-runner');
        const installed = {
          bundleID: plan.runnerBundleID,
          url: 'file:///owned-runner.app',
          version: '1',
        };
        installations.push(installed);
        return installed;
      },
      capture: () => {
        effects.push('capture');
        return {
          totalTestCount: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
          deviceUDID: plan.deviceUDID,
          testIdentifier: 'DictationCaptureTests/testCapture',
          gesture: {
            runID,
            nonce,
            bundleID: plan.bundleID,
            destination: plan.deviceUDID,
            action: 'tap-system-dictate',
            status: 'capture-window-ended',
            control: {
              label: 'Dictate',
              identifier: 'Dictate',
              hittable: true,
              frame: { x: 300, y: 700, width: 40, height: 40 },
            },
          },
        };
      },
      copyArtifact: () => {
        effects.push('copy');
        return JSON.stringify({
          formatVersion: 1,
          runID,
          nonce,
          declaredDestination: plan.deviceUDID,
          destinationBinding: 'declared-only',
          acceptance: 'unreviewed-raw-capture',
          artifactRelativePath: `tmp/editor294-${runID}/capture.json`,
          maximumDurationSeconds: plan.seconds,
          provenance: { sourceSHA: plan.sourceSHA, sourceFingerprint: plan.sourceFingerprint },
          status: 'capture-window-ended',
          sourceUTF16: [95, 95, 97, 98, 95, 95, 32, 38, 97, 109, 112, 59, 32, 99, 100, 13, 10],
          opening: { textUTF16: [97] },
          current: { textUTF16: [97, 98] },
          events: [{ id: 1, parent: null, method: 'insertText' }],
          lifecycle: [{ event: 'ready' }, { event: 'capture-window-ended' }],
          traits: { systemName: 'iOS' },
          os: 'iOS',
        });
      },
    },
  };
  if (reserve) acquireLease(plan, leaseRuntime);
  return { directory, plan, effects, runtime, clean: () => rmSync(directory, { recursive: true }) };
}
