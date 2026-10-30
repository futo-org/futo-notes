#!/usr/bin/env node
// Explicit, host-local physical-fixture reservations. No device discovery, pool
// membership, automatic claim, stale takeover, reset, installation, or cleanup.
// The designated owner must stay alive with the same OS process start identity.
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const UUID = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const fields = [
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
];

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid lease owner PID');
  const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
    encoding: 'utf8',
  }).trim();
  if (!start) throw new Error('Lease owner is not live');
  return start;
}

function runtimeDefaults(runtime) {
  return {
    directory: runtime.directory ?? physicalFixtureHostPaths().leaseDirectory,
    host: hostname(),
    processIdentity,
    ...runtime,
  };
}

// One transport host has one namespace, independent of caller TMPDIR or user.
// Other users refuse the existing private directory instead of making a second
// reservation namespace. Resource tools use the same fixed locations.
export function physicalFixtureHostPaths() {
  const root = realpathSync('/tmp');
  return {
    leaseDirectory: join(root, 'futo-physical-fixture-leases'),
    evidenceDirectory: join(root, 'futo-editor294'),
  };
}

function reservation(plan, runtime) {
  if (plan.host !== runtime.host) throw new Error('Physical transport owner host differs');
  if (!/^[0-9A-F]{8}-[0-9A-F]{16}$/.test(plan.deviceUDID) || !UUID.test(plan.coreDeviceID))
    throw new Error('An exact physical hardware UDID and CoreDevice ID are required');
  if (!UUID.test(plan.runID) || !UUID.test(plan.nonce) || plan.runID === plan.nonce)
    throw new Error('Fresh distinct run and nonce UUIDs are required');
  if (!/^[0-9a-f]{40}$/.test(plan.sourceSHA) || !/^[0-9a-f]{64}$/.test(plan.sourceFingerprint))
    throw new Error('Exact source identity is required');
  if (
    !/^[0-9a-f]{64}$/.test(plan.buildFingerprint) ||
    !Number.isInteger(plan.seconds) ||
    plan.seconds < 1 ||
    plan.seconds > 120
  )
    throw new Error('Exact fixture build and bounded duration are required');
  if (
    plan.bundleID !== 'org.futo.fixture.editor294' ||
    plan.runnerBundleID !== 'org.futo.fixture.editor294.uitests.xctrunner'
  )
    throw new Error('Only the standalone fixture identities may be reserved');
  if (realpathSync(plan.worktree) !== plan.worktree) throw new Error('Canonical checkout required');
  const ownerStart = runtime.processIdentity(plan.ownerPID);
  if (!ownerStart) throw new Error('Lease owner is not live');
  return {
    formatVersion: 1,
    ...Object.fromEntries(fields.map((key) => [key, plan[key]])),
    ownerStart,
  };
}

function leasePath(plan, runtime) {
  const key = createHash('sha256').update(plan.deviceUDID).digest('hex');
  return join(runtime.directory, `${key}.json`);
}

function validateDirectory(runtime) {
  const directory = lstatSync(runtime.directory);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o777) !== 0o700 ||
    realpathSync(runtime.directory) !== runtime.directory
  )
    throw new Error('Lease directory ownership, canonical path or private mode differs; no repair');
}

function lockLease(plan, runtime) {
  mkdirSync(runtime.directory, { recursive: true, mode: 0o700 });
  validateDirectory(runtime);
  const path = leasePath(plan, runtime) + '.in-use';
  const identity = JSON.stringify({
    ownerPID: process.pid,
    ownerStart: runtime.processIdentity(process.pid),
    runID: plan.runID,
  });
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error('Physical reservation is in use; no takeover', { cause: error });
    throw error;
  }
  try {
    writeFileSync(fd, identity);
  } finally {
    closeSync(fd);
  }
  return () => {
    if (readFileSync(path, 'utf8') !== identity)
      throw new Error('Physical reservation lock changed; retained');
    unlinkSync(path);
  };
}

export function acquireLease(plan, options = {}) {
  const runtime = runtimeDefaults(options);
  const lease = reservation(plan, runtime);
  const unlock = lockLease(plan, runtime);
  try {
    let fd;
    try {
      fd = openSync(leasePath(plan, runtime), 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error('Physical device is already reserved; no takeover', { cause: error });
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify(lease) + '\n');
    } finally {
      closeSync(fd);
    }
    return lease;
  } finally {
    unlock();
  }
}

export function readLease(plan, options = {}) {
  const runtime = runtimeDefaults(options);
  const expected = reservation(plan, runtime);
  validateDirectory(runtime);
  const path = leasePath(plan, runtime);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('Invalid lease file');
  const lease = JSON.parse(readFileSync(path, 'utf8'));
  if (JSON.stringify(lease) !== JSON.stringify(expected))
    throw new Error('Physical lease, source, run, or owner process identity differs');
  return lease;
}

export function releaseLease(plan, options = {}) {
  const runtime = runtimeDefaults(options);
  readLease(plan, runtime);
  const unlock = lockLease(plan, runtime);
  try {
    readLease(plan, runtime);
    unlinkSync(leasePath(plan, runtime));
  } finally {
    unlock();
  }
}

export async function useLease(plan, action, options = {}) {
  const runtime = runtimeDefaults(options);
  readLease(plan, runtime);
  const unlock = lockLease(plan, runtime);
  try {
    readLease(plan, runtime);
    return await action();
  } finally {
    unlock();
  }
}

/// The operator starts this task-owned foreground process, never an unrelated
/// PID. It remains live across separate Puppet calls and exits after exact
/// release/close. Interrupting it preserves a stale lease for explicit diagnosis.
export async function holdLease(template, options = {}) {
  if (Object.hasOwn(template, 'ownerPID'))
    throw new Error('The reservation keeper owns its PID; omit ownerPID');
  const runtime = runtimeDefaults(options);
  const plan = { ...template, ownerPID: process.pid };
  const lease = acquireLease(plan, runtime);
  const manifest = join(runtime.directory, `manifest-${plan.runID}-${plan.nonce}.json`);
  try {
    writeFileSync(manifest, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    releaseLease(plan, runtime);
    throw error;
  }
  const resource = {
    formatVersion: 1,
    kind: 'physical-fixture-reservation',
    host: lease.host,
    deviceUDID: lease.deviceUDID,
    runID: lease.runID,
    ownerPID: lease.ownerPID,
    ownerStart: lease.ownerStart,
    manifest,
    createdPaths: [manifest, leasePath(plan, runtime)],
    stop: `just puppet physical-fixture close --run ${plan.runID}`,
  };
  (options.report ?? ((value) => console.log(JSON.stringify(value))))(resource);
  for (;;) {
    await setTimeout(100);
    try {
      readLease(plan, runtime);
    } catch (error) {
      if (error.code === 'ENOENT' && !existsSync(leasePath(plan, runtime)))
        return { released: plan.runID, manifest, evidenceRetained: true };
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, flag, path, ...extra] = process.argv.slice(2);
  if (
    !['acquire', 'read', 'release'].includes(operation) ||
    flag !== '--manifest' ||
    !path ||
    extra.length
  )
    throw new Error('physical-fixture-lease acquire|read|release --manifest <path>');
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const result = await { acquire: holdLease, read: readLease, release: releaseLease }[operation](
    plan,
  );
  console.log(JSON.stringify(result ?? { released: plan.runID }));
}
