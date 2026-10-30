// qa.mjs shared state: pool size, state and SDK paths, process helpers, worktree identity and
// the per-device owner files that make a claim.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slotOf } from '../lib/slot.mjs';

export const LEGACY_ANDROID_AVDS = ['futo-api28', 'futo-api29', 'futo-api30'];
export const POOL = 7; // devices per platform; bump if you routinely run more worktrees
export const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();
const STATE = path.join(HOME, '.futo-notes-qa');
export const DEV_DIR = path.join(STATE, 'devices');
export const SRV_DIR = path.join(STATE, 'server');
const ANDROID_HOME =
  process.env.ANDROID_HOME || path.join(HOME, IS_MAC ? 'Library/Android/sdk' : 'Android/Sdk');
export const EMULATOR = path.join(ANDROID_HOME, 'emulator/emulator');
export const AVDMANAGER = path.join(ANDROID_HOME, 'cmdline-tools/latest/bin/avdmanager');
export const SDKMANAGER = path.join(ANDROID_HOME, 'cmdline-tools/latest/bin/sdkmanager');
export const SIM_DEVICE_TYPE = process.env.QA_SIM_DEVICE_TYPE || 'iPhone 17 Pro';
export const AVD_DIR = path.join(process.env.ANDROID_AVD_HOME || path.join(HOME, '.android/avd'));

export const info = (msg) => process.stderr.write(msg + '\n');
export const die = (msg) => {
  process.stderr.write(`qa: ${msg}\n`);
  process.exit(1);
};
export const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
export const tryRun = (cmd, args, opts = {}) => {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── worktree identity ──────────────────────────────────────────────────────

export function worktreeRoot() {
  const out = tryRun('git', ['rev-parse', '--show-toplevel']);
  if (!out) die('not inside a git worktree');
  return out.trim();
}

function branchOf(root) {
  return (tryRun('git', ['-C', root, 'branch', '--show-current']) || '').trim() || '(detached)';
}

// ── owner files ────────────────────────────────────────────────────────────

export const ownerPath = (platform, name) => path.join(DEV_DIR, `${platform}-${name}.json`);

export function readOwner(platform, name) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(platform, name), 'utf8'));
  } catch {
    return null;
  }
}

export const ownerIsStale = (owner) => !fs.existsSync(owner.worktree);

// The device's id (adb serial or simulator udid) in its owner file, which `just puppet` reads
// without starting node. An emulator's serial can change when it restarts; `device` rewrites it.
export function recordId(platform, name, id) {
  const owner = readOwner(platform, name);
  if (owner && owner.id !== id) {
    fs.writeFileSync(ownerPath(platform, name), JSON.stringify({ ...owner, id }, null, 2));
  }
}

// Atomically claim a device name for this worktree. Exclusive create (wx)
// makes two SIMULTANEOUS claimers of the same name resolve safely: exactly
// one wins, the loser re-reads and moves on. (Reclaiming a stale owner has a
// tiny overwrite race — acceptable: it requires two sessions claiming within
// milliseconds on behalf of an already-deleted worktree.) Returns 'new' when
// this call took the device (free, or from a stale owner) or this worktree's
// earlier claim never finished its handover wipe (`wipePending`: the boot died
// first), 'held' when the worktree already owned it, false when a live
// worktree owns it.
function tryClaimOwner(platform, name, root) {
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const payload = JSON.stringify(
    {
      worktree: root,
      branch: branchOf(root),
      claimedAt: new Date().toISOString(),
      wipePending: true,
    },
    null,
    2,
  );
  try {
    fs.writeFileSync(ownerPath(platform, name), payload, { flag: 'wx' });
    return 'new';
  } catch {
    const owner = readOwner(platform, name);
    if (owner && owner.worktree === root) return owner.wipePending ? 'new' : 'held';
    if (!owner || ownerIsStale(owner)) {
      fs.writeFileSync(ownerPath(platform, name), payload);
      return 'new';
    }
    return false;
  }
}

// The handover wipe finished: later claims by this worktree are 'held'.
export function markWiped(platform, name) {
  const owner = readOwner(platform, name);
  if (!owner) return;
  delete owner.wipePending;
  fs.writeFileSync(ownerPath(platform, name), JSON.stringify(owner, null, 2));
}

// Claim this worktree's pool device: start at slot % POOL, linear-probe past
// devices owned by other live worktrees, reclaim stale ones. `fresh` is true
// when the device changed hands and no wipe has completed since, i.e. its app
// data may belong to someone else; call markWiped once it has been wiped.
export function claimPoolName(platform, root, { sim, inspectSimulators } = {}) {
  if (sim && platform !== 'ios') throw new Error('--sim requires the explicit ios target');
  if (platform !== 'ios') return allocatePoolName(platform, root);
  // Serialize selection and persistence, including default allocation. Never hold
  // this across boot/wipe. A crashed allocator leaves a visible lock for inspection.
  const file = path.join(STATE, 'ios-allocation.lock');
  fs.mkdirSync(STATE, { recursive: true });
  const payload = JSON.stringify({ worktree: root, pid: process.pid, token: randomUUID() });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`another iOS allocation owns ${file}; inspect the lock before retrying`);
    throw error;
  }
  const identity = fs.fstatSync(fd);
  const ownsLock = () => {
    try {
      const current = fs.statSync(file);
      return (
        current.ino === identity.ino &&
        current.dev === identity.dev &&
        fs.readFileSync(file, 'utf8') === payload
      );
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  try {
    fs.writeFileSync(fd, payload);
    if (!sim) return allocatePoolName(platform, root);
    const devices = inspectSimulators();
    const matches = devices.filter((device) => device.name === sim || device.udid === sim);
    const selected = matches[0];
    const names = Array.from({ length: POOL }, (_, index) => `futo-qa-${index}`);
    if (
      matches.length !== 1 ||
      !names.includes(selected?.name) ||
      selected.isAvailable === false ||
      devices.filter((device) => device.name === selected.name && device.isAvailable !== false)
        .length !== 1
    )
      throw new Error(
        `--sim requires an exact existing available QA pool simulator name or ID: ${sim}`,
      );
    // A preference never moves this worktree off another existing iOS claim.
    const owned = fs.existsSync(DEV_DIR)
      ? fs.readdirSync(DEV_DIR).filter((file) => {
          const match = file.match(/^ios-(.+)\.json$/);
          return (
            match && match[1] !== selected.name && readOwner('ios', match[1])?.worktree === root
          );
        })
      : [];
    if (owned.length)
      throw new Error(
        'this worktree already owns a different iOS simulator; release it explicitly before selecting --sim',
      );
    if (!ownsLock()) throw new Error('iOS allocation lock identity changed; refusing claim');
    const claim = tryClaimOwner('ios', selected.name, root);
    if (!claim)
      throw new Error(`${selected.name} is claimed by another live worktree; refusing --sim`);
    return { name: selected.name, fresh: claim === 'new' };
  } finally {
    // Release only the exact lock created here, never a replacement's token/inode.
    try {
      if (ownsLock()) fs.unlinkSync(file);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function allocatePoolName(platform, root) {
  const start = slotOf(root) % POOL;
  for (let k = 0; k < POOL; k++) {
    const name = `futo-qa-${(start + k) % POOL}`;
    const claim = tryClaimOwner(platform, name, root);
    if (claim) return { name, fresh: claim === 'new' };
  }
  throw new Error(
    `all ${POOL} ${platform} pool devices are owned by live worktrees — release one (just qa-release) or run just qa-gc`,
  );
}

// Explicit legacy fixtures participate in ownership but retain their pinned
// images and app state. The caller must verify the AVD exists before claiming.
export function claimNamedAndroid(root, name) {
  if (!LEGACY_ANDROID_AVDS.includes(name)) {
    throw new Error(`unsupported QA AVD ${name}; use ${LEGACY_ANDROID_AVDS.join(', ')}`);
  }
  const claim = tryClaimOwner('android', name, root);
  if (!claim) throw new Error(`${name} is claimed by another worktree`);
  return { name, fresh: claim === 'new' };
}
