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
function tryClaimOwner(platform, name, root, assertOwnership = () => {}, fields = {}) {
  assertOwnership();
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const payload = JSON.stringify(
    {
      worktree: root,
      branch: branchOf(root),
      claimedAt: new Date().toISOString(),
      wipePending: true,
      ...fields,
    },
    null,
    2,
  );
  // Revalidate here after filesystem/branch lookup, at every owner write path.
  // Keeping this in the persistence owner covers default and preferred callers.
  assertOwnership();
  try {
    fs.writeFileSync(ownerPath(platform, name), payload, { flag: 'wx' });
    return 'new';
  } catch {
    const owner = readOwner(platform, name);
    if (owner && owner.worktree === root) return owner.wipePending ? 'new' : 'held';
    if (!owner || ownerIsStale(owner)) {
      assertOwnership();
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
  return withAllocationLock(platform, root, (assertOwnership) => {
    if (platform === 'android') {
      assertNoPhysicalClaim(root);
      return allocatePoolName(platform, root, assertOwnership);
    }
    // Read current ownership only after acquiring the lock: a preferred claim
    // may have finished while this invocation was still resolving its worktree.
    const owned = fs.existsSync(DEV_DIR)
      ? fs
          .readdirSync(DEV_DIR)
          .sort()
          .flatMap((file) => {
            const match = file.match(/^ios-(.+)\.json$/);
            const owner = match && readOwner('ios', match[1]);
            return owner?.worktree === root
              ? [{ name: match[1], fresh: owner.wipePending === true }]
              : [];
          })
      : [];
    assertOwnership();
    if (!sim) {
      const result = owned[0] ?? allocatePoolName(platform, root, assertOwnership);
      assertOwnership();
      return Object.freeze(result);
    }
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
    if (owned.some((owner) => owner.name !== selected.name))
      throw new Error(
        'this worktree already owns a different iOS simulator; release it explicitly before selecting --sim',
      );
    const claim = tryClaimOwner('ios', selected.name, root, assertOwnership);
    if (!claim)
      throw new Error(`${selected.name} is claimed by another live worktree; refusing --sim`);
    assertOwnership();
    return Object.freeze({ name: selected.name, fresh: claim === 'new' });
  });
}

function withAllocationLock(platform, root, allocate) {
  // Serialize selection and persistence, including default allocation. Never hold
  // this across boot/wipe. A crashed allocator leaves a visible lock for inspection.
  const file = path.join(STATE, `${platform}-allocation.lock`);
  fs.mkdirSync(STATE, { recursive: true });
  const payload = JSON.stringify({ worktree: root, pid: process.pid, token: randomUUID() });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `another ${platform === 'ios' ? 'iOS' : 'Android'} allocation owns ${file}; inspect the lock before retrying`,
      );
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
    const assertOwnership = () => {
      if (!ownsLock())
        throw new Error(
          `${platform === 'ios' ? 'iOS' : 'Android'} allocation lock identity changed; refusing claim`,
        );
    };
    return allocate(assertOwnership);
  } finally {
    // Release only the exact lock created here, never a replacement's token/inode.
    try {
      if (ownsLock()) fs.unlinkSync(file);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function allocatePoolName(platform, root, assertOwnership) {
  const start = slotOf(root) % POOL;
  for (let k = 0; k < POOL; k++) {
    const name = `futo-qa-${(start + k) % POOL}`;
    // An --extra claim is only ever a shard target, never the worktree's own device.
    if (readOwner(platform, name)?.extra && readOwner(platform, name).worktree === root) continue;
    const claim = tryClaimOwner(platform, name, root, assertOwnership);
    if (claim) return { name, fresh: claim === 'new' };
  }
  throw new Error(
    `all ${POOL} ${platform} pool devices are owned by live worktrees — release one (just qa-release) or run just qa-gc`,
  );
}

// Emulators one worktree may hold at once: other lanes share the pool.
export const MAX_ANDROID_CLAIMS = 3;

// `qa-claim android --extra`: one more pool emulator for this worktree, used only
// to shard instrumentation (`just test-android-ui --shard`). It is marked `extra`
// so `just puppet` and a plain claim keep using the worktree's first emulator;
// `just qa-release android` frees it with the rest.
export function claimExtraAndroid(root) {
  return withAllocationLock('android', root, (assertOwnership) => {
    assertNoPhysicalClaim(root);
    const held = androidOwners(root);
    if (!held.some(({ owner }) => !owner.extra))
      throw new Error("claim this worktree's emulator first: just qa-claim android");
    if (held.length >= MAX_ANDROID_CLAIMS)
      throw new Error(
        `this worktree already holds ${held.length} Android emulators (limit ${MAX_ANDROID_CLAIMS}); the pool is shared`,
      );
    const start = slotOf(root) % POOL;
    for (let k = 0; k < POOL; k++) {
      const name = `futo-qa-${(start + k) % POOL}`;
      if (readOwner('android', name)?.worktree === root) continue;
      if (tryClaimOwner('android', name, root, assertOwnership, { extra: true }))
        return { name, fresh: true };
    }
    throw new Error(`no free ${POOL}-pool Android emulator for an extra claim`);
  });
}

// Explicit legacy fixtures participate in ownership but retain their pinned
// images and app state. The caller must verify the AVD exists before claiming.
export function claimNamedAndroid(root, name) {
  if (!LEGACY_ANDROID_AVDS.includes(name)) {
    throw new Error(`unsupported QA AVD ${name}; use ${LEGACY_ANDROID_AVDS.join(', ')}`);
  }
  return withAllocationLock('android', root, (assertOwnership) => {
    assertNoPhysicalClaim(root);
    const claim = tryClaimOwner('android', name, root, assertOwnership);
    if (!claim) throw new Error(`${name} is claimed by another worktree`);
    return { name, fresh: claim === 'new' };
  });
}

function androidOwners(root) {
  if (!fs.existsSync(DEV_DIR)) return [];
  return fs
    .readdirSync(DEV_DIR)
    .filter((name) => /^android-.+\.json$/.test(name))
    .map((name) => ({ name: name.slice(8, -5), owner: readOwner('android', name.slice(8, -5)) }))
    .filter(({ owner }) => owner?.worktree === root);
}

function assertNoPhysicalClaim(root) {
  if (androidOwners(root).some(({ owner }) => owner.physical))
    throw new Error('release the physical Android claim explicitly before selecting an emulator');
}

// Exact physical claims never boot/wipe/install or reclaim another owner, even
// a stale one. The same allocation lock prevents ambiguous per-worktree targets.
export function claimPhysicalAndroid(root, serial) {
  const name = physicalAndroidName(serial);
  return withAllocationLock('android', root, (assertOwnership) => {
    if (androidOwners(root).some((item) => item.name !== name))
      throw new Error('release this worktree’s existing Android claim before selecting --serial');
    const file = ownerPath('android', name);
    if (fs.existsSync(file)) {
      const owner = readOwner('android', name);
      if (owner?.worktree !== root || owner.id !== serial || !owner.physical)
        throw new Error(
          'physical Android serial already reserved; explicit owner release required',
        );
      assertPhysicalAndroid(serial);
      return { name, fresh: false };
    }
    const identity = inspectPhysicalAndroid(serial);
    fs.mkdirSync(DEV_DIR, { recursive: true });
    const payload = JSON.stringify(
      {
        worktree: root,
        branch: branchOf(root),
        claimedAt: new Date().toISOString(),
        id: serial,
        physical: true,
        ...identity,
      },
      null,
      2,
    );
    assertOwnership();
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return { name, fresh: false };
  });
}

export function inspectPhysicalAndroid(serial, { execFile = execFileSync } = {}) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 };
  if (execFile('adb', ['-s', serial, 'get-state'], options).trim() !== 'device')
    throw new Error('physical Android device is not connected and authorized');
  const model = execFile(
    'adb',
    ['-s', serial, 'shell', 'getprop', 'ro.product.model'],
    options,
  ).trim();
  const abiList = execFile(
    'adb',
    ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abilist'],
    options,
  ).trim();
  if (!model || !abiList) throw new Error('physical Android model/ABI identity is unavailable');
  return { model, abiList };
}

export function assertPhysicalAndroid(serial, options = {}) {
  const owner = readOwner('android', physicalAndroidName(serial));
  if (!owner?.physical || owner.worktree !== worktreeRoot() || owner.id !== serial)
    throw new Error(
      'physical Android target is unclaimed or foreign; run just qa-claim android --serial SERIAL',
    );
  const current = inspectPhysicalAndroid(serial, options);
  if (owner.model !== current.model || owner.abiList !== current.abiList)
    throw new Error('physical Android model/ABI changed since claim; inspect identity before use');
  return serial;
}

function physicalAndroidName(serial) {
  if (
    typeof serial !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(serial) ||
    serial.startsWith('emulator-')
  )
    throw new Error('--serial requires an exact physical Android serial');
  return `physical-${serial}`;
}
