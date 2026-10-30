// Private retained evidence for the bounded physical fixture. Never follow a
// symlink, alias, shared file or nonprivate path; collisions are not repaired.
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { isFixtureRunID } from './physical-fixture-contract.mjs';

function privateEntry(stat, directory) {
  if (
    stat.uid !== process.getuid() ||
    (directory ? (stat.mode & 0o777) !== 0o700 : ![0o600, 0o700].includes(stat.mode & 0o777)) ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.isSymbolicLink()
  )
    throw new Error('Physical evidence ownership, file type or private mode differs; no repair');
}

export function assertPrivateDirectory(path) {
  privateEntry(lstatSync(path), true);
  if (realpathSync(path) !== path) throw new Error('Physical evidence canonical path differs');
}

export function assertPrivateTree(path) {
  assertPrivateDirectory(path);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isDirectory()) assertPrivateTree(child);
    else privateEntry(stat, false);
  }
}

export function assertEvidenceAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Physical evidence output collision; no overwrite');
}

export function createEvidenceDirectory(path) {
  // The parent must already be canonical. Recursive mkdir could traverse an
  // untrusted intermediate link before we had a chance to validate it.
  if (realpathSync(dirname(path)) !== dirname(path))
    throw new Error('Physical evidence parent canonical path differs');
  mkdirSync(path, { mode: 0o700 });
  assertPrivateDirectory(path);
}

export function evidenceRun(scratch, runID, { create = false } = {}) {
  if (!isFixtureRunID(runID)) throw new Error('Exact evidence run UUID required');
  if (create) {
    try {
      lstatSync(scratch);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      createEvidenceDirectory(scratch);
    }
  }
  assertPrivateDirectory(scratch);
  const output = join(scratch, runID);
  if (create) createEvidenceDirectory(output);
  assertPrivateTree(output);
  return output;
}

function openPrivate(path, flags, { create = false } = {}) {
  assertPrivateDirectory(dirname(path));
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    privateEntry(stat, false);
    const entry = lstatSync(path);
    if (entry.dev !== stat.dev || entry.ino !== stat.ino || entry.isSymbolicLink())
      throw new Error('Physical evidence file changed; retained');
    if (create && stat.size !== 0) throw new Error('Physical evidence output collision');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readEvidence(path, encoding = 'utf8') {
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    return readFileSync(fd, encoding);
  } finally {
    closeSync(fd);
  }
}

export function writeEvidence(path, bytes, { exclusive = false } = {}) {
  let fd;
  if (!exclusive) {
    try {
      fd = openPrivate(path, constants.O_WRONLY);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (fd === undefined)
    fd = openPrivate(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, {
      create: true,
    });
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

export const readEvidenceJSON = (path) => JSON.parse(readEvidence(path));
export const writeEvidenceJSON = (path, value, options) =>
  writeEvidence(path, JSON.stringify(value, null, 2) + '\n', options);

export function evidenceHashes(path, prefix = '') {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    assertPrivateDirectory(path);
    return readdirSync(path)
      .sort()
      .flatMap((name) => evidenceHashes(join(path, name), `${prefix}/${name}`));
  }
  const hash = createHash('sha256').update(readEvidence(path, null)).digest('hex');
  return [{ path: prefix, sha256: hash }];
}
