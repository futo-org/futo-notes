import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLease, releaseLease } from './physical-fixture-lease.mjs';
import { executePhysicalFixture } from './physical-fixture.mjs';

const runID = '650D54CC-6339-4D62-B550-834BFBB8D7AA';
const nonce = '9ADC97CB-1A3D-443E-B5C7-62E50B90CDF1';
function setup() {
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
  acquireLease(plan, leaseRuntime);
  return { directory, plan, effects, runtime, clean: () => rmSync(directory, { recursive: true }) };
}

describe('bounded physical fixture capability', () => {
  it('refuses a foreign transport host before any device lifecycle or input', async () => {
    const t = setup();
    try {
      await expect(
        executePhysicalFixture('capture', t.plan, { ...t.runtime, host: 'foreign-host' }),
      ).rejects.toThrow(/host/);
      expect(t.effects).toEqual([]);
    } finally {
      t.clean();
    }
  });

  it('captures only the fixed scenario, binds its result, and closes without deleting evidence', async () => {
    const t = setup();
    try {
      const receipt = await executePhysicalFixture('capture', t.plan, t.runtime);
      expect(receipt.status).toBe('captured');
      expect(receipt.acceptance).toBe('unreviewed-raw-capture');
      expect(t.effects).toEqual(['install-fixture', 'install-runner', 'capture', 'copy']);
      const read = await executePhysicalFixture('read', t.plan, t.runtime);
      expect(read.artifact.nonce).toBe(nonce);
      await executePhysicalFixture('close', t.plan, t.runtime);
      expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).not.toThrow();
      expect(read.receipt.artifactSHA256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      t.clean();
    }
  });

  it.each([
    ['wrong source', { sourceSHA: 'd'.repeat(40) }],
    ['wrong source fingerprint', { sourceFingerprint: 'd'.repeat(64) }],
    ['wrong build', { buildFingerprint: 'd'.repeat(64) }],
  ])('refuses %s before installation', async (_name, change) => {
    const t = setup();
    t.runtime.executor.inspectBuild = () => ({ ...t.plan, ...change });
    try {
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
        /identity/,
      );
      expect(t.effects).toEqual([]);
    } finally {
      t.clean();
    }
  });

  it.each([
    { physical: false },
    { available: false },
    { unlocked: false },
    { deviceUDID: '00008150-0000000000000000' },
    { coreDeviceID: nonce },
    { installations: [{ bundleID: 'org.futo.fixture.editor294', url: 'unknown', version: '1' }] },
  ])(
    'refuses unavailable, foreign, simulated or preinstalled targets before installation %j',
    async (change) => {
      const t = setup();
      const inspect = t.runtime.executor.inspectDevice;
      t.runtime.executor.inspectDevice = () => ({ ...inspect(), ...change });
      try {
        await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow();
        expect(t.effects).toEqual([]);
      } finally {
        t.clean();
      }
    },
  );
});

describe('physical fixture attempt evidence and reservation lifetime', () => {
  it.each(['Dictate absent', 'unexpected prompt', 'bounded capture timeout'])(
    'does not auto-read after %s; an explicit read retains raw evidence with a failure receipt',
    async (message) => {
      const t = setup();
      t.runtime.executor.capture = () => {
        t.effects.push('capture');
        throw new Error(message);
      };
      try {
        await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(message);
        expect(t.effects).toEqual(['install-fixture', 'install-runner', 'capture']);
        await expect(executePhysicalFixture('read', t.plan, t.runtime)).rejects.toThrow(
          /raw evidence retained/,
        );
        expect(t.effects.at(-1)).toBe('copy');
        expect(
          (await executePhysicalFixture('close', t.plan, t.runtime)).evidenceRetained,
        ).toContain(runID);
      } finally {
        t.clean();
      }
    },
  );

  it.each([
    { totalTestCount: 0 },
    { deviceUDID: nonce },
    { skippedTests: 1 },
    { gesture: { runID, nonce: runID } },
  ])('refuses unmatched XCTest results before artifact read %j', async (change) => {
    const t = setup();
    const capture = t.runtime.executor.capture;
    t.runtime.executor.capture = () => ({ ...capture(), ...change });
    try {
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow();
      expect(t.effects).toEqual(['install-fixture', 'install-runner', 'capture']);
    } finally {
      t.clean();
    }
  });

  it.each(['{"formatVersion":', JSON.stringify({ runID, nonce })])(
    'retains and refuses incomplete raw artifact %s',
    async (raw) => {
      const t = setup();
      t.runtime.executor.copyArtifact = () => {
        t.effects.push('copy');
        return raw;
      };
      try {
        await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
          /artifact/,
        );
        await expect(executePhysicalFixture('read', t.plan, t.runtime)).rejects.toThrow(
          /raw evidence retained/,
        );
      } finally {
        t.clean();
      }
    },
  );

  it('accepts equivalent sorted JSON provenance emitted by the native artifact writer', async () => {
    const t = setup();
    const copy = t.runtime.executor.copyArtifact;
    t.runtime.executor.copyArtifact = () => {
      const artifact = JSON.parse(copy());
      artifact.provenance = {
        sourceFingerprint: t.plan.sourceFingerprint,
        sourceSHA: t.plan.sourceSHA,
      };
      return JSON.stringify(artifact);
    };
    try {
      expect((await executePhysicalFixture('capture', t.plan, t.runtime)).status).toBe('captured');
    } finally {
      t.clean();
    }
  });

  it('holds the host hardware reservation through the full bounded XCTest operation', async () => {
    const t = setup();
    const capture = t.runtime.executor.capture;
    t.runtime.executor.capture = () => {
      expect(() => releaseLease(t.plan, t.runtime.leaseRuntime)).toThrow(/in use/);
      return capture();
    };
    try {
      expect((await executePhysicalFixture('capture', t.plan, t.runtime)).status).toBe('captured');
    } finally {
      t.clean();
    }
  });

  it('holds the same reservation through explicit read validation', async () => {
    const t = setup();
    try {
      await executePhysicalFixture('capture', t.plan, t.runtime);
      const inspect = t.runtime.executor.inspectBuild;
      t.runtime.executor.inspectBuild = () => {
        expect(() => releaseLease(t.plan, t.runtime.leaseRuntime)).toThrow(/in use/);
        return inspect();
      };
      expect((await executePhysicalFixture('read', t.plan, t.runtime)).artifact.nonce).toBe(nonce);
    } finally {
      t.clean();
    }
  });

  it.each([
    { sourceUTF16: [] },
    { events: [] },
    { current: { textUTF16: [97] } },
    { nonce: runID },
    { artifactRelativePath: 'Documents/fake-notes/private.md' },
    { provenance: { sourceSHA: 'd'.repeat(40) } },
  ])('refuses wrong, stale, or result-free raw capture %j', async (change) => {
    const t = setup();
    const copy = t.runtime.executor.copyArtifact;
    t.runtime.executor.copyArtifact = () => JSON.stringify({ ...JSON.parse(copy()), ...change });
    try {
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
        /artifact|result/,
      );
    } finally {
      t.clean();
    }
  });
});
