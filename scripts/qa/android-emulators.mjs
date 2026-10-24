// qa.mjs Android pool: the futo-qa-N AVDs, their hardware baseline, and booting them.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertAndroidTarget } from './android-target.mjs';
import {
  AVDMANAGER,
  AVD_DIR,
  EMULATOR,
  IS_MAC,
  SDKMANAGER,
  die,
  info,
  sleep,
  tryRun,
} from './pool.mjs';

// Baseline for pool AVDs: a cheap-but-current Android phone (Moto G Play,
// Galaxy A16 class) — 720x1600 @320dpi, i.e. 360x800dp at 20:9. 360dp is the
// most common Android width in the wild, so it's the size layout bugs show up
// at first. avdmanager's default when you pass no `-d` is 320x640 @160dpi,
// which is a 2010 handset and too small to QA anything; `-d small_phone` is
// closer but 16:9 and only 640dp tall. The rest of these keys undo the same
// generic default's other 2010-isms (96MB RAM, no GPU, hardware nav keys) —
// without them a 720x1600 API-36 emulator still won't be usable.
const AVD_BASELINE = {
  'hw.lcd.width': '720',
  'hw.lcd.height': '1600',
  'hw.lcd.density': '320',
  'hw.ramSize': '2048',
  'vm.heapSize': '256',
  'hw.gpu.enabled': 'yes',
  'hw.gpu.mode': 'auto',
  'hw.keyboard': 'yes', // type with the host keyboard instead of tapping glass
  'hw.mainKeys': 'no', // software nav, like every phone since ~2016
  'hw.dPad': 'no',
  'hw.trackBall': 'no',
};

// A named device profile (hw.device.name=pixel_6 + its hash) re-asserts that
// device's screen over the keys above — Studio flags the mismatch and offers to
// revert it. Pool AVDs are generic by design, so drop the profile and its skin.
const AVD_PROFILE_KEYS = [
  'hw.device.name',
  'hw.device.manufacturer',
  'hw.device.hash2',
  'skin.name',
  'skin.path',
];

// ── Android emulators ──────────────────────────────────────────────────────

export const avdNames = () => (tryRun(EMULATOR, ['-list-avds']) || '').split('\n').filter(Boolean);

// serial → AVD name for every running emulator (physical devices are skipped)
export function runningEmus() {
  const out = {};
  const devices = tryRun('adb', ['devices']) || '';
  for (const m of devices.matchAll(/^(emulator-\d+)\tdevice$/gm)) {
    const name = (tryRun('adb', ['-s', m[1], 'emu', 'avd', 'name']) || '').split('\n')[0].trim();
    if (name) out[name] = m[1];
  }
  return out;
}

function installedSystemImage() {
  const list = tryRun(SDKMANAGER, ['--list_installed']) || '';
  const images = [...list.matchAll(/^\s*(system-images;\S+)/gm)].map((m) => m[1]);
  if (!images.length)
    die(
      `no Android system image installed — e.g.: ${SDKMANAGER} "system-images;android-36;google_apis;${IS_MAC ? 'arm64-v8a' : 'x86_64'}"`,
    );
  const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  // Pick the HIGHEST API level for the host arch. sdkmanager lists images
  // alphabetically, so a plain `.find()` grabs android-30 before android-36 and
  // silently claims a stale emulator — API-35+ behavior (e.g. enforced
  // edge-to-edge) then goes untested. Rank by the numeric API in `android-<N>`;
  // preview/codename images (non-numeric) sort last.
  const apiLevel = (i) => {
    const m = i.match(/;android-(\d+);/);
    return m ? Number(m[1]) : -1;
  };
  const candidates = images
    .filter((i) => i.includes(arch))
    .sort((a, b) => apiLevel(b) - apiLevel(a));
  return candidates[0] || images[0];
}

// Force an AVD's config.ini to AVD_BASELINE. Runs on every claim, not just on
// create, so AVDs made before the baseline existed get fixed in place rather
// than needing a manual recreate. Screen geometry is baked into a saved
// snapshot, so a change means the snapshots have to go and the next boot is
// cold. Deliberately does not touch a running emulator — pulling its snapshots
// out from under it corrupts them; it gets fixed on the next claim after
// shutdown.
export function applyAvdBaseline(name) {
  const dir = path.join(AVD_DIR, `${name}.avd`);
  const cfg = path.join(dir, 'config.ini');
  if (!fs.existsSync(cfg)) return;
  if (runningEmus()[name]) {
    info(`skipping baseline for ${name}: emulator is running (re-claim after shutdown)`);
    return;
  }

  // config.ini is written as both `k = v` (avdmanager) and `k=v` (Studio).
  // Preserve whichever the file already uses so the diff stays minimal.
  const lines = fs.readFileSync(cfg, 'utf8').split('\n');
  const pending = new Map(Object.entries(AVD_BASELINE));
  let changed = false;
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([\w.]+)(\s*=\s*)(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    if (AVD_PROFILE_KEYS.includes(m[1])) {
      changed = true;
      continue;
    }
    if (!pending.has(m[1])) {
      out.push(line);
      continue;
    }
    const want = pending.get(m[1]);
    pending.delete(m[1]);
    if (m[3].trim() !== want) changed = true;
    out.push(`${m[1]}${m[2]}${want}`);
  }
  if (pending.size) {
    const sep = out.some((l) => /^[\w.]+ = /.test(l)) ? ' = ' : '=';
    for (const [k, v] of pending) out.push(`${k}${sep}${v}`);
    changed = true;
  }
  if (!changed) return;

  info(`applying screen baseline to ${name} (720x1600 @320dpi) — next boot is cold`);
  fs.writeFileSync(cfg, out.filter((l, i) => l !== '' || i < out.length - 1).join('\n'));
  fs.rmSync(path.join(dir, 'snapshots'), { recursive: true, force: true });
  // hardware-qemu.ini is the previous boot's resolved config; stale geometry
  // there wins over config.ini on a fastboot resume.
  fs.rmSync(path.join(dir, 'hardware-qemu.ini'), { force: true });
}

// Android can turn this off after host-keyboard input. Pin it before the app
// runs, then reboot when changed so InputMethodManager observes the setting.
function pinSoftKeyboard(name, serial) {
  assertAndroidTarget({ serial, expectedAvd: name, allowPending: true });
  const args = ['-s', serial, 'shell', 'settings'];
  const read = () => tryRun('adb', [...args, 'get', 'secure', 'show_ime_with_hard_keyboard']);
  const current = read();
  if (current === null) die(`cannot read the software-keyboard setting on ${name}`);
  if (current.trim() === '1') return false;
  if (
    tryRun('adb', [...args, 'put', 'secure', 'show_ime_with_hard_keyboard', '1']) === null ||
    read()?.trim() !== '1'
  )
    die(`cannot enable the software keyboard on ${name}`);
  return true;
}

async function stopAvd(name, serial) {
  assertAndroidTarget({ serial, expectedAvd: name, allowPending: true });
  if (tryRun('adb', ['-s', serial, 'emu', 'kill']) === null) die(`could not stop ${name}`);
  for (let i = 0; i < 60; i++) {
    if (!runningEmus()[name]) return;
    await sleep(500);
  }
  die(`emulator ${name} did not stop for its requested reboot`);
}

export async function ensureAvd(
  name,
  { preserveConfig = false, reboot = false, keyboardRestarted = false, coldBoot = false } = {},
) {
  if (!avdNames().includes(name)) {
    if (preserveConfig)
      die(`legacy QA AVD ${name} does not exist; create the pinned fixture first`);
    const image = installedSystemImage();
    info(`creating AVD ${name} (${image})`);
    // avdmanager prompts "create a custom hardware profile?" — answer no.
    const res = spawnSync(AVDMANAGER, ['create', 'avd', '-n', name, '-k', image], {
      input: 'no\n',
      encoding: 'utf8',
    });
    if (res.status !== 0) die(`avdmanager create failed:\n${res.stderr || res.stdout}`);
  }
  if (!preserveConfig) applyAvdBaseline(name);
  let serial = runningEmus()[name];
  if (serial && reboot) {
    if (!preserveConfig) pinSoftKeyboard(name, serial);
    await stopAvd(name, serial);
    serial = null;
    coldBoot = true;
  }
  if (!serial) {
    info(`booting emulator ${name} (first boot can take a couple of minutes)`);
    const child = spawn(EMULATOR, ['-avd', name, ...(coldBoot ? ['-no-snapshot-load'] : [])], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 60 && !serial; i++) {
      await sleep(2000);
      serial = runningEmus()[name];
    }
    if (!serial) die(`emulator ${name} did not appear in adb devices`);
    for (let i = 0; i < 90; i++) {
      const boot = (
        tryRun('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) || ''
      ).trim();
      // boot_completed flips before servicemanager has registered the package
      // service, and the next thing a caller does is install the app —
      // `adb install` then dies with "cmd: Can't find service: package".
      const packageService = tryRun('adb', ['-s', serial, 'shell', 'service', 'check', 'package']);
      if (boot === '1' && (packageService || '').includes('found')) break;
      await sleep(2000);
      if (i === 89) die(`emulator ${name} (${serial}) did not finish booting`);
    }
    // The package service being registered doesn't mean system_server has
    // finished wiring every system service class an install touches. An
    // install issued in that gap dies instead with a NullPointerException
    // from `StorageManager.getVolumes()` inside
    // `PackageInstallerService.createSessionInternal` (same race hit CI:
    // main pipeline 36733/36730, scripts/ci-android-emulator.sh). `pm
    // install-create` exercises that exact path without writing anything, so
    // wait on it rather than assuming package-service readiness covers it.
    let storageReady = false;
    for (let i = 0; i < 60; i++) {
      const created = tryRun('adb', ['-s', serial, 'shell', 'pm', 'install-create']) || '';
      const match = created.match(/\[(\d+)\]/);
      if (created.includes('Success') && match) {
        tryRun('adb', ['-s', serial, 'shell', 'pm', 'install-abandon', match[1]]);
        storageReady = true;
        break;
      }
      await sleep(2000);
    }
    if (!storageReady) die(`emulator ${name} (${serial}): storage manager never came up`);
  }
  if (!preserveConfig && pinSoftKeyboard(name, serial)) {
    if (keyboardRestarted) die(`software-keyboard setting did not persist after rebooting ${name}`);
    info(`rebooting ${name} after enabling the software keyboard`);
    await stopAvd(name, serial);
    return ensureAvd(name, { keyboardRestarted: true, coldBoot: true });
  }
  return serial;
}

// The debug app every Android QA leg installs. Its vault and sync state outlive
// a claim, so a fresh claim inherited an earlier leg's notes and pushed them to
// its own new server (pc_4bc25890e000). `pm clear` takes the package's storage
// (INTERNAL and APP vaults, prefs, sync state); DEVICE mode keeps its vault in
// shared storage, outside the package (NotesStorage.deviceFolderName(true)).
const DEV_PACKAGE = 'com.futo.notes.dev';
const DEV_DEVICE_VAULT = '/storage/emulated/0/Documents/FUTO Notes Dev';

// Wipe the debug app's data on a pool emulator, leaving the install. Returns an
// error message, or null once the app and the DEVICE-mode vault are both empty.
export function wipeDevApp(serial) {
  const shell = (...args) => tryRun('adb', ['-s', serial, 'shell', ...args]);
  const installed = (shell('pm', 'path', DEV_PACKAGE) || '').includes('package:');
  if (installed && !(shell('pm', 'clear', DEV_PACKAGE) || '').includes('Success')) {
    return `pm clear ${DEV_PACKAGE} failed`;
  }
  // adb shell joins its arguments into one device-side command line.
  shell('rm', '-rf', `"${DEV_DEVICE_VAULT}"`);
  if (shell('ls', `"${DEV_DEVICE_VAULT}"`) !== null) return `could not delete ${DEV_DEVICE_VAULT}`;
  return null;
}
