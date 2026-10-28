// Explicit recovery for an owned QA simulator whose software keyboard remains
// parked after a reboot/disconnect. Never called automatically: erase discards
// all of the simulator's apps, vaults and settings. The normal claimer reboots
// and disconnects the hardware keyboard after this completes.
import { findSim } from './ios-simulators.mjs';
import { POOL, readOwner, run, sleep } from './pool.mjs';

export function existingIosRecoveryClaim(devices) {
  const owned = devices.filter((device) => device.platform === 'ios');
  if (owned.length !== 1)
    throw new Error('--erase needs exactly one existing iOS claim; run just qa-claim ios first');
  return owned[0].name;
}

export async function eraseSimulator(
  udid,
  { assertOwned, stateOf, execute = run, wait = sleep, now = Date.now, timeoutMs = 30000 } = {},
) {
  if (typeof assertOwned !== 'function' || typeof stateOf !== 'function')
    throw new Error('Simulator recovery requires an ownership check and state probe');
  assertOwned();
  if (stateOf() === 'Booted') {
    assertOwned();
    execute('xcrun', ['simctl', 'shutdown', udid], { timeout: 30000 });
  }
  const deadline = now() + timeoutMs;
  while (stateOf() !== 'Shutdown') {
    assertOwned();
    if (now() >= deadline)
      throw new Error(`Simulator ${udid} did not reach Shutdown; refusing erase`);
    await wait(100);
  }
  assertOwned();
  execute('xcrun', ['simctl', 'erase', udid], { timeout: 120000 });
  assertOwned();
}

export async function eraseClaimedPoolSimulator(
  name,
  root,
  { inspect = findSim, owner = readOwner, ...runtime } = {},
) {
  if (!Array.from({ length: POOL }, (_, index) => `futo-qa-${index}`).includes(name))
    throw new Error('Erase is restricted to named QA pool simulators');
  const assertClaim = () => {
    if (owner('ios', name)?.worktree !== root)
      throw new Error(`Simulator ${name} is not owned by this worktree; refusing erase`);
  };
  assertClaim();
  const original = inspect(name);
  if (!original) return null; // No existing state: the claimer will create a fresh device.
  const assertOwned = () => {
    assertClaim();
    const current = inspect(name);
    if (current?.udid !== original.udid || current?.name !== name)
      throw new Error(`Simulator ${name} identity changed; refusing erase`);
  };
  await eraseSimulator(original.udid, {
    ...runtime,
    assertOwned,
    stateOf: () => {
      assertOwned();
      return inspect(name).state;
    },
  });
  return original.udid;
}
