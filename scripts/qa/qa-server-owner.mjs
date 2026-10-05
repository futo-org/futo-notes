import fs from 'node:fs';
import path from 'node:path';

const OWNER_FILE = 'owner.json';
const START_FILE = 'starting.lock';

export function serverOwner(dir) {
  const file = path.join(dir, OWNER_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof owner.worktree !== 'string' || !owner.worktree) throw new Error('missing worktree');
    return owner;
  } catch {
    throw new Error(
      `sync server ownership is unknown because ${file} is malformed; inspect it before proceeding`,
    );
  }
}

export function assertServerOwner(dir, root) {
  const owner = serverOwner(dir);
  if (owner && owner.worktree !== root) {
    throw new Error(
      `sync server belongs to another worktree (${owner.worktree}); refusing to use it`,
    );
  }
  return owner;
}

// Exclusive files serialize callers before a server can be spawned. A crashed
// starter leaves a visible lock for manual inspection instead of allowing two
// same-slot worktrees to launch concurrent servers.
export function acquireServerStartLock(dir, root) {
  const file = path.join(dir, START_FILE);
  try {
    fs.writeFileSync(file, JSON.stringify({ worktree: root, pid: process.pid }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`another sync server start owns ${file}; inspect the lock before retrying`);
    throw error;
  }
  return () => fs.rmSync(file, { force: true });
}

// Lock first, then claim ownership. If a concurrent starter holds the lock,
// this call cannot leave a claim behind that blocks the actual lock owner.
export function acquireOwnedServerStart(dir, root) {
  const release = acquireServerStartLock(dir, root);
  try {
    const createdOwner = claimServerOwner(dir, root);
    return { createdOwner, release };
  } catch (error) {
    release();
    throw new Error(error.message, { cause: error });
  }
}

export function shouldCleanServerDir({ meta, owner, pid }) {
  return Boolean(meta || owner || pid);
}

export function claimServerOwner(dir, root) {
  const file = path.join(dir, OWNER_FILE);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ worktree: root, claimedAt: new Date().toISOString() }, null, 2),
      { flag: 'wx' },
    );
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const owner = assertServerOwner(dir, root);
  if (!owner) throw new Error(`sync server ownership is unknown at ${file}`);
  return false;
}

export function releaseServerOwner(dir, root) {
  assertServerOwner(dir, root);
  fs.rmSync(path.join(dir, OWNER_FILE), { force: true });
}
