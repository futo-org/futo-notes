// Fixed physical-fixture lifecycle behind `just puppet physical-fixture`.
// Device executors are the OS boundary, never caller-selected commands/filters.
// No pooled target resolution, signing, provisioning, preference repair or reset.
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  evidenceRun,
  assertPrivateTree,
  assertEvidenceAbsent,
  createEvidenceDirectory,
  readEvidence,
  readEvidenceJSON as json,
  writeEvidence,
  writeEvidenceJSON as write,
} from './physical-fixture-evidence.mjs';
import {
  readLease,
  releaseLease,
  useLease,
  physicalFixtureHostPaths,
} from './physical-fixture-lease.mjs';

import {
  validateFixturePlan,
  validateTerminalReceipt,
  validateFixtureResult,
} from './physical-fixture-contract.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  validateFixturePlan(plan);
  if (plan.host !== host) throw new Error('Physical transport owner host differs');
  if (plan.worktree !== root) throw new Error('Physical fixture checkout differs');
  readLease(plan, runtime.leaseRuntime);
  const output = join(scratch, plan.runID);
  const receiptPath = join(output, 'receipt.json');
  if (operation !== 'capture') evidenceRun(scratch, plan.runID);
  const retainedReceipt = () => {
    evidenceRun(scratch, plan.runID);
    if (JSON.stringify(json(join(output, 'manifest.json'))) !== JSON.stringify(plan))
      throw new Error('Retained run manifest differs');
    const receipt = json(receiptPath);
    validateTerminalReceipt(plan, receipt, output);
    if (receipt.status === 'captured') {
      validateFixtureResult(plan, receipt.result);
      if (digest(readEvidence(join(output, 'capture.json'))) !== receipt.artifactSHA256)
        throw new Error('Retained capture hash differs');
    }
    return receipt;
  };
  if (operation === 'close') {
    releaseLease(plan, runtime.leaseRuntime, retainedReceipt);
    return { runID: plan.runID, status: 'closed', evidenceRetained: output };
  }
  const deviceObservations = [];
  let activeReceipt;
  const guard = async (installations) => {
    readLease(plan, runtime.leaseRuntime);
    if (activeReceipt || operation === 'read') evidenceRun(scratch, plan.runID);
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
        const receipt = retainedReceipt();
        const build = await guard(receipt.installations);
        if (receipt.status === 'failed') {
          const rawOutput = join(output, `failed-read-${randomUUID()}`);
          createEvidenceDirectory(rawOutput);
          const raw = await executor.copyArtifact(plan, rawOutput);
          const rawPath = join(rawOutput, 'capture.json');
          assertPrivateTree(output);
          writeEvidence(rawPath, raw, { exclusive: true });
          receipt.rawReads = [...(receipt.rawReads ?? []), { path: rawPath, sha256: digest(raw) }];
          write(receiptPath, receipt);
          await guard(receipt.installations);
          throw new Error(`Attempt remains failed; raw evidence retained at ${rawPath}`);
        }
        if (receipt.status !== 'captured') throw new Error('Unknown retained capture state');
        validateFixtureResult(plan, receipt.result);
        const raw = readEvidence(join(output, 'capture.json'));
        if (digest(raw) !== receipt.artifactSHA256)
          throw new Error('Retained capture hash differs');
        return { receipt, artifact: validateArtifact(plan, build, raw) };
      },
      runtime.leaseRuntime,
    );
  }
  return useLease(
    plan,
    async () => {
      assertEvidenceAbsent(output);
      let build = await guard([]);
      evidenceRun(scratch, plan.runID, { create: true });
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
        build = await executor.pinBuild(plan, build, output);
        if (build.buildFingerprint !== plan.buildFingerprint)
          throw new Error('Pinned fixture build identity differs');
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
        validateFixtureResult(plan, receipt.result);
        await guard(receipt.installations);
        const raw = await executor.copyArtifact(plan, output);
        assertPrivateTree(output);
        writeEvidence(join(output, 'capture.json'), raw, { exclusive: true });
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
