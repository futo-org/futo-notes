// qa.mjs shared state: pool size, state and SDK paths, process helpers, worktree identity and
// the per-device owner files that make a claim.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slotOf } from '../lib/slot.mjs';

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

// Atomically claim a device name for this worktree. Exclusive create (wx)
// makes two SIMULTANEOUS claimers of the same name resolve safely: exactly
// one wins, the loser re-reads and moves on. (Reclaiming a stale owner has a
// tiny overwrite race — acceptable: it requires two sessions claiming within
// milliseconds on behalf of an already-deleted worktree.)
function tryClaimOwner(platform, name, root) {
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const payload = JSON.stringify(
    { worktree: root, branch: branchOf(root), claimedAt: new Date().toISOString() },
    null,
    2,
  );
  try {
    fs.writeFileSync(ownerPath(platform, name), payload, { flag: 'wx' });
    return true;
  } catch {
    const owner = readOwner(platform, name);
    if (owner && owner.worktree === root) return true; // already ours
    if (!owner || ownerIsStale(owner)) {
      fs.writeFileSync(ownerPath(platform, name), payload);
      return true;
    }
    return false;
  }
}

// Claim this worktree's pool device: start at slot % POOL, linear-probe past
// devices owned by other live worktrees, reclaim stale ones.
export function claimPoolName(platform, root) {
  const start = slotOf(root) % POOL;
  for (let k = 0; k < POOL; k++) {
    const name = `futo-qa-${(start + k) % POOL}`;
    if (tryClaimOwner(platform, name, root)) return name;
  }
  die(
    `all ${POOL} ${platform} pool devices are owned by live worktrees — release one (just qa-release) or run just qa-gc`,
  );
}
