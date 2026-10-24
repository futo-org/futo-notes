// A pooled emulator's adb serial can be recycled by a different AVD. Resolve
// its name and verify the worktree's claim immediately before device access.
// Physical devices and CI's non-pool AVDs retain their existing explicit setup.
import { execFileSync } from 'node:child_process';
import { readOwner, worktreeRoot } from './pool.mjs';

export function assertAndroidTarget({
  serial = process.env.ANDROID_SERIAL,
  expectedAvd = process.env.ANDROID_AVD_NAME,
  execFile = execFileSync,
} = {}) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 };
  const target = serial || execFile('adb', ['get-serialno'], options).trim();
  if (!target) throw new Error('no Android device selected; run just qa-claim android');
  if (!target.startsWith('emulator-')) return target;
  const name = execFile('adb', ['-s', target, 'emu', 'avd', 'name'], options)
    .split(/\r?\n/)[0]
    .trim();
  if (!name) throw new Error(`cannot identify emulator ${target}; run just qa-claim android`);
  if (expectedAvd && expectedAvd !== name) {
    throw new Error(`${target} is ${name}, expected ${expectedAvd}; re-run just qa-claim android`);
  }
  if (/^futo-qa-\d+$/.test(name)) {
    const owner = readOwner('android', name);
    if (!owner) throw new Error(`${name} is unclaimed; run just qa-claim android`);
    if (owner.worktree !== worktreeRoot()) {
      throw new Error(
        `${name} is claimed by another worktree (${owner.worktree}); re-run just qa-claim android`,
      );
    }
    if (owner.wipePending)
      throw new Error(`${name} claim is not ready; re-run just qa-claim android`);
  }
  return target;
}
