import { expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { readLease, processIdentity } from './physical-fixture-lease.mjs';
import { runPhysicalFixtureCLI } from './physical-fixture-cli.mjs';

it('refuses extra arguments and arbitrary XCTest commands before loading a manifest', async () => {
  for (const args of [
    [],
    ['capture', '--test', 'arbitrary'],
    ['read', '--run', '../other'],
    ['capture', '--manifest', 'unused', '--device', 'foreign'],
  ]) {
    await expect(runPhysicalFixtureCLI(args)).rejects.toThrow(/physical-fixture/);
  }
});

function createMockCLI(root) {
  const template = {
    formatVersion: 1,
    host: hostname(),
    deviceUDID: '00008150-001C70A634F0401C',
    coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
    worktree: root,
    sourceSHA: 'a'.repeat(40),
    sourceFingerprint: 'b'.repeat(64),
    runID: '650D54CC-6339-4D62-B550-834BFBB8D7AA',
    nonce: '9ADC97CB-1A3D-443E-B5C7-62E50B90CDF1',
    bundleID: 'org.futo.fixture.editor294',
    runnerBundleID: 'org.futo.fixture.editor294.uitests.xctrunner',
    seconds: 10,
    buildFingerprint: 'c'.repeat(64),
  };
  const templatePath = join(root, 'template.json');
  const helper = join(root, 'mock-physical-cli.mjs');
  writeFileSync(templatePath, JSON.stringify(template));
  writeFileSync(join(root, 'device-state.json'), '[]');
  // Only the external device executor is simulated. The CLI, files, real child
  // processes, exclusive leases and OS PID/start observations are production code.
  writeFileSync(
    helper,
    `
import { holdLease, useLease, releaseLease } from ${JSON.stringify(new URL('./physical-fixture-lease.mjs', import.meta.url).href)};
import { runPhysicalFixtureCLI } from ${JSON.stringify(new URL('./physical-fixture-cli.mjs', import.meta.url).href)};
import { recorderPayload } from ${JSON.stringify(new URL('./physical-fixture-test-data.mjs', import.meta.url).href)};
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)};
const template = JSON.parse(readFileSync(${JSON.stringify(templatePath)}, 'utf8'));
const leaseRuntime = { directory: join(root, 'leases'), host: template.host };
const statePath = join(root, 'device-state.json');
const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const install = (bundleID) => { const installed = {bundleID, version: '1', url: 'file:///owned/' + bundleID};
  writeFileSync(statePath, JSON.stringify([...state(), installed])); return installed; };
const provenance = {sourceSHA: template.sourceSHA, sourceFingerprint: template.sourceFingerprint};
const executor = {
  pinBuild: (_plan, build) => build,
      inspectBuild: () => ({...provenance, provenance, buildFingerprint: template.buildFingerprint}),
  inspectDevice: () => ({deviceUDID: template.deviceUDID, coreDeviceID: template.coreDeviceID,
    physical: true, available: true, unlocked: true, installations: state()}),
  installFixture: () => install(template.bundleID), installRunner: () => install(template.runnerBundleID),
  capture: () => ({totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0,
    deviceUDID: template.deviceUDID, testIdentifier: 'DictationCaptureTests/testCapture',
    gesture: {runID: template.runID, nonce: template.nonce, bundleID: template.bundleID,
      destination: template.deviceUDID, action: 'tap-system-dictate', status: 'capture-window-ended',
      control: {label: 'Dictate', identifier: 'Dictate', hittable: true, frame: {x: 1,y: 1,width: 40,height: 40}}}}),
  copyArtifact: () => JSON.stringify({formatVersion: 1,runID: template.runID,nonce: template.nonce,
    declaredDestination: template.deviceUDID,destinationBinding: 'declared-only',acceptance: 'unreviewed-raw-capture',
    artifactRelativePath: 'tmp/editor294-' + template.runID + '/capture.json', maximumDurationSeconds: 10,
    provenance,status: 'capture-window-ended',sourceUTF16: [95,95,97,98,95,95,32,38,97,109,112,59,32,99,100,13,10],
    ...recorderPayload()}),
};
if (process.argv[2] === 'acquire') console.log(JSON.stringify(await holdLease(template, leaseRuntime)));
else if (process.argv[2] === 'interrupt-use') {
  const plan = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  await useLease(plan, async () => {console.log('IN_USE'); await new Promise(() => {setInterval(() => {}, 1000);});}, leaseRuntime);
}
else if (process.argv[2] === 'release') releaseLease(JSON.parse(readFileSync(process.argv[3], 'utf8')), leaseRuntime);
else console.log(JSON.stringify(await runPhysicalFixtureCLI(process.argv.slice(2),
  {root,host: template.host,scratch: join(root, 'runs'),leaseRuntime,executor})));
`,
  );
  return { template, helper };
}

it.each(['happy', 'killed-keeper', 'interrupted-use'])(
  'preserves actual separate-process ownership across %s lifecycle',
  async (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'physical-cli-process-test-')));
    const { helper } = createMockCLI(root);
    const keeper = spawn(process.execPath, [helper, 'acquire'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(keeper, 'exit');
    let stderr = '';
    keeper.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    try {
      const resource = await Promise.race([
        new Promise((resolve, reject) => {
          let text = '';
          keeper.stdout.on('data', (chunk) => {
            text += chunk;
            if (text.includes('\n')) {
              try {
                resolve(JSON.parse(text.split('\n')[0]));
              } catch (error) {
                reject(error);
              }
            }
          });
          keeper.once('exit', () =>
            reject(new Error('Keeper exited before acquire receipt: ' + stderr)),
          );
        }),
        delay(3000, undefined, { ref: false }).then(() => {
          throw new Error('No acquire receipt');
        }),
      ]);
      const plan = JSON.parse(readFileSync(resource.manifest, 'utf8'));
      expect(plan.ownerPID).toBe(keeper.pid);
      expect(resource.ownerStart).toBe(processIdentity(keeper.pid));
      expect(readLease(plan, { directory: join(root, 'leases'), host: hostname() }).ownerPID).toBe(
        keeper.pid,
      );
      const invoke = (...args) =>
        JSON.parse(
          execFileSync(process.execPath, [helper, ...args], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        );
      const namespace = () =>
        Object.fromEntries(
          readdirSync(join(root, 'leases'))
            .sort()
            .map((name) => [name, readFileSync(join(root, 'leases', name), 'utf8')]),
        );
      if (mode === 'killed-keeper') {
        const before = namespace();
        keeper.kill('SIGTERM');
        await exited;
        expect(() => invoke('acquire')).toThrow();
        expect(namespace()).toEqual(before);
        expect(readFileSync(resource.manifest, 'utf8')).toBe(JSON.stringify(plan, null, 2) + '\n');
        return;
      }
      expect(invoke('capture', '--manifest', resource.manifest).status).toBe('captured');
      if (mode === 'interrupted-use') {
        const user = spawn(process.execPath, [helper, 'interrupt-use', resource.manifest], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const userExited = once(user, 'exit');
        try {
          await Promise.race([
            new Promise((resolve, reject) => {
              user.stdout.on('data', (bytes) => {
                if (bytes.toString().includes('IN_USE')) resolve();
              });
              user.once('exit', () => reject(new Error('Use process exited early')));
            }),
            delay(3000, undefined, { ref: false }).then(() => {
              throw new Error('No in-use receipt');
            }),
          ]);
          user.kill('SIGTERM');
          await userExited;
          const before = namespace();
          const receipt = readFileSync(join(root, 'runs', plan.runID, 'receipt.json'), 'utf8');
          for (const args of [
            ['capture', '--manifest', resource.manifest],
            ['read', '--run', plan.runID],
            ['close', '--run', plan.runID],
            ['release', resource.manifest],
          ])
            expect(() => invoke(...args)).toThrow();
          expect(namespace()).toEqual(before);
          expect(readFileSync(join(root, 'runs', plan.runID, 'receipt.json'), 'utf8')).toBe(
            receipt,
          );
        } finally {
          if (user.exitCode === null && user.signalCode === null) user.kill('SIGTERM');
          await userExited;
        }
        return;
      }
      expect(invoke('read', '--run', plan.runID).artifact.nonce).toBe(plan.nonce);
      expect(invoke('close', '--run', plan.runID).status).toBe('closed');
      expect(
        await Promise.race([
          exited,
          delay(3000, undefined, { ref: false }).then(() => {
            throw new Error('Keeper did not exit after exact close');
          }),
        ]),
      ).toEqual([0, null]);
      expect(() =>
        readLease(plan, { directory: join(root, 'leases'), host: hostname() }),
      ).toThrow();
    } finally {
      if (keeper.exitCode === null && keeper.signalCode === null) keeper.kill('SIGTERM');
      await exited;
      rmSync(root, { recursive: true });
    }
  },
  12000,
);
