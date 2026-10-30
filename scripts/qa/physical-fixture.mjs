// Fixed physical-fixture lifecycle behind `just puppet physical-fixture`.
// Device executors are the OS boundary, never caller-selected commands/filters.
// No pooled target resolution, signing, provisioning, preference repair or reset.
import { hostname } from 'node:os';
import process from 'node:process';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  readLease,
  releaseLease,
  useLease,
  physicalFixtureHostPaths,
} from './physical-fixture-lease.mjs';

const planFields = [
  'formatVersion',
  'host',
  'deviceUDID',
  'coreDeviceID',
  'worktree',
  'sourceSHA',
  'sourceFingerprint',
  'runID',
  'nonce',
  'ownerPID',
  'bundleID',
  'runnerBundleID',
  'seconds',
  'buildFingerprint',
].sort();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const ordered = (installations) =>
  [...installations].sort((a, b) => a.bundleID.localeCompare(b.bundleID));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function validatePlan(plan) {
  if (
    !plan ||
    JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(planFields) ||
    plan.formatVersion !== 1 ||
    !Number.isInteger(plan.seconds) ||
    plan.seconds < 1 ||
    plan.seconds > 120 ||
    !/^[0-9a-f]{64}$/.test(plan.buildFingerprint)
  )
    throw new Error('Expected the fixed, bounded physical fixture manifest');
}

function validateDevice(plan, device, installations) {
  if (
    device.deviceUDID !== plan.deviceUDID ||
    device.coreDeviceID !== plan.coreDeviceID ||
    device.physical !== true ||
    device.available !== true ||
    device.unlocked !== true
  )
    throw new Error('Physical device identity, availability, or unlocked state differs');
  if (
    !Array.isArray(device.installations) ||
    JSON.stringify(ordered(device.installations)) !== JSON.stringify(ordered(installations))
  )
    throw new Error('Unknown or changed fixture installation; no replacement permitted');
}

function validateResult(plan, result) {
  const gesture = result?.gesture;
  if (
    result?.totalTestCount !== 1 ||
    result.passedTests !== 1 ||
    result.failedTests !== 0 ||
    result.skippedTests !== 0 ||
    result.deviceUDID !== plan.deviceUDID ||
    result.testIdentifier !== 'DictationCaptureTests/testCapture'
  )
    throw new Error('Fixed XCTest scenario or actual device destination did not pass exactly once');
  const control = gesture?.control;
  if (
    gesture?.runID !== plan.runID ||
    gesture.nonce !== plan.nonce ||
    gesture.bundleID !== plan.bundleID ||
    gesture.destination !== plan.deviceUDID ||
    gesture.action !== 'tap-system-dictate' ||
    gesture.status !== 'capture-window-ended' ||
    control?.hittable !== true ||
    !['Dictate', 'Start Dictation'].includes(control.label) ||
    !control.frame ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(control.frame[key])) ||
    control.frame.width <= 0 ||
    control.frame.height <= 0
  )
    throw new Error('Missing or mismatched live system Dictate gesture receipt');
}

function validateArtifact(plan, build, raw) {
  let artifact;
  try {
    artifact = JSON.parse(raw);
  } catch {
    throw new Error('Malformed or partial capture artifact');
  }
  if (
    artifact?.formatVersion !== 1 ||
    artifact.runID !== plan.runID ||
    artifact.nonce !== plan.nonce ||
    artifact.declaredDestination !== plan.deviceUDID ||
    artifact.destinationBinding !== 'declared-only' ||
    artifact.acceptance !== 'unreviewed-raw-capture' ||
    artifact.maximumDurationSeconds !== plan.seconds ||
    artifact.artifactRelativePath !== `tmp/editor294-${plan.runID}/capture.json` ||
    artifact.status !== 'capture-window-ended' ||
    JSON.stringify(canonical(artifact.provenance)) !== JSON.stringify(canonical(build.provenance))
  )
    throw new Error('Capture artifact identity, provenance, path, or completion differs');
  const utf16 = (units) =>
    Array.isArray(units) && units.every((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
  if (
    !utf16(artifact.sourceUTF16) ||
    !utf16(artifact.opening?.textUTF16) ||
    !utf16(artifact.current?.textUTF16) ||
    !Array.isArray(artifact.events) ||
    !Array.isArray(artifact.lifecycle) ||
    !artifact.lifecycle.some((e) => e.event === 'ready') ||
    !artifact.lifecycle.some((e) => e.event === 'capture-window-ended') ||
    !artifact.traits ||
    !artifact.os
  )
    throw new Error('Capture artifact is incomplete');
  const source = [95, 95, 97, 98, 95, 95, 32, 38, 97, 109, 112, 59, 32, 99, 100, 13, 10];
  if (JSON.stringify(artifact.sourceUTF16) !== JSON.stringify(source))
    throw new Error('Capture artifact does not contain the fixed public-store source');
  if (
    artifact.events.length === 0 ||
    artifact.current.marked != null ||
    JSON.stringify(artifact.opening.textUTF16) === JSON.stringify(artifact.current.textUTF16)
  )
    throw new Error('Capture produced no completed result; raw artifact retained');
  return artifact;
}

export async function executePhysicalFixture(operation, plan, runtime) {
  const {
    root,
    host = hostname(),
    scratch = physicalFixtureHostPaths().evidenceDirectory,
    executor,
  } = runtime;
  if (!['capture', 'read', 'close'].includes(operation))
    throw new Error('Unknown fixture operation');
  validatePlan(plan);
  if (plan.host !== host) throw new Error('Physical transport owner host differs');
  if (plan.worktree !== root) throw new Error('Physical fixture checkout differs');
  readLease(plan, runtime.leaseRuntime);
  const output = join(scratch, plan.runID);
  const receiptPath = join(output, 'receipt.json');
  if (operation === 'close') {
    const receipt = json(receiptPath);
    if (
      JSON.stringify(json(join(output, 'manifest.json'))) !== JSON.stringify(plan) ||
      receipt.runID !== plan.runID ||
      receipt.status === 'running'
    )
      throw new Error('Cannot close an unknown or unfinished capture');
    releaseLease(plan, runtime.leaseRuntime);
    return { runID: plan.runID, status: 'closed', evidenceRetained: output };
  }
  const deviceObservations = [];
  let activeReceipt;
  const guard = async (installations) => {
    readLease(plan, runtime.leaseRuntime);
    const build = await executor.inspectBuild(plan);
    if (
      build.sourceSHA !== plan.sourceSHA ||
      build.sourceFingerprint !== plan.sourceFingerprint ||
      build.buildFingerprint !== plan.buildFingerprint
    )
      throw new Error('Physical fixture source or build identity differs');
    const device = await executor.inspectDevice(plan);
    validateDevice(plan, device, installations);
    deviceObservations.push({ at: new Date().toISOString(), ...device });
    if (activeReceipt) write(receiptPath, activeReceipt);
    return build;
  };
  if (operation === 'read') {
    return useLease(
      plan,
      async () => {
        if (JSON.stringify(json(join(output, 'manifest.json'))) !== JSON.stringify(plan))
          throw new Error('Retained run manifest differs');
        const receipt = json(receiptPath);
        if (receipt.status === 'running')
          throw new Error('Capture remains in progress; no read or takeover');
        const build = await guard(receipt.installations);
        if (receipt.status === 'failed') {
          const rawOutput = join(output, `failed-read-${randomUUID()}`);
          mkdirSync(rawOutput, { mode: 0o700 });
          const raw = await executor.copyArtifact(plan, rawOutput);
          const rawPath = join(rawOutput, 'capture.json');
          writeFileSync(rawPath, raw, { flag: 'wx', mode: 0o600 });
          receipt.rawReads = [...(receipt.rawReads ?? []), { path: rawPath, sha256: digest(raw) }];
          write(receiptPath, receipt);
          await guard(receipt.installations);
          throw new Error(`Attempt remains failed; raw evidence retained at ${rawPath}`);
        }
        if (receipt.status !== 'captured') throw new Error('Unknown retained capture state');
        validateResult(plan, receipt.result);
        const raw = readFileSync(join(output, 'capture.json'), 'utf8');
        if (digest(raw) !== receipt.artifactSHA256)
          throw new Error('Retained capture hash differs');
        return { receipt, artifact: validateArtifact(plan, build, raw) };
      },
      runtime.leaseRuntime,
    );
  }
  const build = await guard([]);
  if (existsSync(output)) throw new Error('Capture output collision; no overwrite');
  return useLease(
    plan,
    async () => {
      await guard([]);
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const parent = lstatSync(scratch);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.uid !== process.getuid() ||
        (parent.mode & 0o777) !== 0o700
      )
        throw new Error('Capture output parent ownership or private mode differs; no repair');
      mkdirSync(output, { mode: 0o700 });
      write(join(output, 'manifest.json'), plan);
      write(join(output, 'build.json'), {
        sourceSHA: build.sourceSHA,
        sourceFingerprint: build.sourceFingerprint,
        buildFingerprint: build.buildFingerprint,
        provenance: build.provenance,
        artifacts: build.artifacts,
      });
      const receipt = {
        formatVersion: 1,
        runID: plan.runID,
        nonce: plan.nonce,
        acceptance: 'unreviewed-raw-capture',
        status: 'running',
        installations: [],
        output,
        deviceObservations,
      };
      activeReceipt = receipt;
      write(receiptPath, receipt);
      try {
        for (const [method, bundleID] of [
          ['installFixture', plan.bundleID],
          ['installRunner', plan.runnerBundleID],
        ]) {
          await guard(receipt.installations);
          const installation = await executor[method](plan, build, output);
          if (installation?.bundleID !== bundleID || !installation.url || !installation.version)
            throw new Error('Fixture installation receipt differs');
          receipt.installations.push(installation);
          write(receiptPath, receipt);
        }
        await guard(receipt.installations);
        receipt.result = await executor.capture(plan, build, output);
        write(receiptPath, receipt);
        validateResult(plan, receipt.result);
        await guard(receipt.installations);
        const raw = await executor.copyArtifact(plan, output);
        writeFileSync(join(output, 'capture.json'), raw, { flag: 'wx', mode: 0o600 });
        await guard(receipt.installations);
        validateArtifact(plan, build, raw);
        receipt.artifactSHA256 = digest(raw);
        receipt.status = 'captured';
        write(receiptPath, receipt);
        return receipt;
      } catch (error) {
        receipt.status = 'failed';
        receipt.error = error.message;
        write(receiptPath, receipt);
        throw error;
      }
    },
    runtime.leaseRuntime,
  );
}
