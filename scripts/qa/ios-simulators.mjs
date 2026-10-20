// qa.mjs iOS pool: the futo-qa-N simulators, created and booted on demand.
import { disconnectHardwareKeyboard } from '../lib/simulator-keyboard.mjs';
import { SIM_DEVICE_TYPE, die, info, run, sleep, tryRun } from './pool.mjs';

// ── iOS simulators ─────────────────────────────────────────────────────────

function simDevices() {
  const json = JSON.parse(run('xcrun', ['simctl', 'list', '-j', 'devices']));
  const out = [];
  for (const [runtime, devices] of Object.entries(json.devices)) {
    for (const d of devices) out.push({ ...d, runtime });
  }
  return out;
}

export const findSim = (name) =>
  simDevices().find((d) => d.name === name && d.isAvailable !== false);

// `reboot: true` forces a full shutdown -> boot -> attach cycle.
//
// A simulator booted without a Simulator.app window in the CURRENT WindowServer
// context makes `axe`/`idb` UI commands return a degenerate 0x0 root, while
// `simctl screenshot` keeps working perfectly. So the failure looks like the app
// rendering nothing rather than a windowing problem, and an agent can burn a long
// session concluding the UI is unreadable (pc_93dab75886da). Re-running
// `open -a Simulator` against an ALREADY-RUNNING Simulator.app does not fix it —
// `--args` is only read at launch — so the repair is the full cycle, which is
// what `just qa-claim ios --reboot` now does.
export async function ensureSim(name, { reboot = false } = {}) {
  let sim = findSim(name);
  if (!sim) {
    info(`creating simulator ${name} (${SIM_DEVICE_TYPE})`);
    run('xcrun', ['simctl', 'create', name, SIM_DEVICE_TYPE]);
    sim = findSim(name);
    if (!sim) die(`simctl create ${name} did not produce a device`);
  }
  if (reboot && sim.state === 'Booted') {
    info(`rebooting simulator ${name} (${sim.udid}) to re-attach a window`);
    tryRun('xcrun', ['simctl', 'shutdown', sim.udid]);
    for (let i = 0; i < 30 && findSim(name)?.state === 'Booted'; i++) await sleep(1000);
    sim = findSim(name);
  }
  if (sim.state !== 'Booted') {
    info(`booting simulator ${name} (${sim.udid})`);
    tryRun('xcrun', ['simctl', 'boot', sim.udid]); // "already booted" is fine
    for (let i = 0; i < 30 && findSim(name)?.state !== 'Booted'; i++) await sleep(1000);
    if (findSim(name)?.state !== 'Booted') die(`simulator ${name} did not reach Booted`);
  }
  // Make sure Simulator.app is running and ask it to front THIS device.
  //
  // Honest limitation: `-CurrentDeviceUDID` is only read when Simulator.app
  // LAUNCHES. If it is already running (commonly, showing another worktree's
  // device) this just activates it and the flag is ignored — measured. So this
  // covers the "Simulator.app not running at all" case, and --reboot above is
  // the documented repair for a booted device whose UI reads as a 0x0 root.
  // Quitting Simulator.app is deliberately NOT done: sibling worktrees' claimed
  // devices share the one app instance.
  //
  // Xcode 27 ships no Simulator.app, so this fails there and the device runs
  // headless, which QA handles. Its replacement, DeviceHub, is deliberately NOT
  // opened: while it runs it takes the touchscreen of EVERY booted simulator,
  // and backboardd then rejects each `axe tap` ("already have a main display
  // digitizer") while AXe reports success.
  if (tryRun('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', sim.udid]) === null) {
    info(`note: no Simulator.app to open (Xcode 27+); ${name} runs headless`);
  }
  // A connected hardware keyboard hides the software keyboard (XCUITest's
  // `app.keyboards.firstMatch` still "exists" there, parked at the window's
  // bottom edge: the find-bar UI test's "132.0 is not less than 24.0" on
  // futo-qa-5). Every boot re-attaches it, so this repeats on every claim (and
  // after the `open` above, which on Xcode <=26 applies Simulator.app's own
  // default: connected). POOL DEVICES ONLY — never the developer's own simulators.
  try {
    disconnectHardwareKeyboard(sim.udid);
  } catch (error) {
    info(`warning: could not disconnect the hardware keyboard on ${name}: ${error.message}`);
  }
  return findSim(name).udid;
}
