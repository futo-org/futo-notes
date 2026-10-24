#!/usr/bin/env node
// Parallel-QA isolation: per-worktree devices and sync servers.
//
// Multiple Claude Code sessions (or humans) can QA different worktrees on one
// machine without colliding. The model mirrors the /verify skill's port
// scheme: the worktree path hashes to a SLOT, and the slot deterministically
// claims pooled devices (iOS simulators + Android AVDs named futo-qa-0..6)
// and a sync server (per-slot port + per-slot SQLite database so parallel
// runs can't clobber each other's data).
//
// Ownership is an owner-file per device under ~/.futo-notes-qa/devices/,
// containing the claiming worktree path. Staleness is self-healing: an owner
// whose worktree directory no longer exists is reclaimable — no TTLs, no
// heartbeats. Pool devices plus explicitly named futo-api28/29/30 fixtures are managed.
// Named fixtures retain their images and app data; personal devices are never touched.
//
//   node scripts/qa.mjs claim [ios|android|all] [--reboot] [--avd legacy-name]   # ensure+boot devices, print exports
//   node scripts/qa.mjs status                    # pool devices + servers, owners, state
//   node scripts/qa.mjs release [ios|android] [--shutdown]  # release this worktree's claims
//   node scripts/qa.mjs gc                        # reap devices/servers of deleted worktrees
//   node scripts/qa.mjs server-start              # per-slot sync server (own SQLite DB + blobs)
//   node scripts/qa.mjs server-stop [--drop]      # stop it; --drop also deletes its DB + blobs
//
// `claim` prints `export SIM=…` / `export ANDROID_SERIAL=…` lines on stdout
// (progress goes to stderr), so shells can `eval "$(node scripts/qa.mjs claim all)"`.

import { showCameraPoster } from './qa/android-camera.mjs';
import { verifyAndroidApk } from './qa/android-apk.mjs';
import { assertAndroidTarget } from './qa/android-target.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { slotOf } from './lib/slot.mjs';
import {
  applyAvdBaseline,
  avdNames,
  ensureAvd,
  runningEmus,
  wipeDevApp as wipeAndroidDevApp,
} from './qa/android-emulators.mjs';
import { ensureSim, findSim, wipeDevApp as wipeIosDevApp } from './qa/ios-simulators.mjs';
import {
  AVDMANAGER,
  DEV_DIR,
  IS_MAC,
  LEGACY_ANDROID_AVDS,
  POOL,
  SRV_DIR,
  claimPoolName,
  claimNamedAndroid,
  markWiped,
  die,
  info,
  ownerIsStale,
  ownerPath,
  readOwner,
  tryRun,
  worktreeRoot,
} from './qa/pool.mjs';
import {
  cmdServerStart,
  pidAlive,
  readJson,
  readPid,
  serverStop,
  stopServerDir,
} from './qa/slot-server.mjs';

// ── commands ───────────────────────────────────────────────────────────────

// A device that changed hands is handed out with the debug app's data wiped.
// The claim stays `wipePending` until the wipe succeeds, so a boot that dies
// first (die exits) still leaves the retry to wipe; a failed wipe drops the claim.
function wipeOnFreshClaim(platform, name, fresh, wipe) {
  if (!fresh) return;
  const error = wipe();
  if (error) {
    fs.rmSync(ownerPath(platform, name), { force: true });
    die(`${platform} ${name}: ${error}; claim released`);
  }
  markWiped(platform, name);
  info(`${platform}: wiped com.futo.notes.dev data on ${name} (new claim)`);
}

async function cmdClaim(target, { reboot = false, avd } = {}) {
  const root = worktreeRoot();
  if (avd) {
    if (target !== 'android') die('--avd requires the android target');
    if (!LEGACY_ANDROID_AVDS.includes(avd)) die(`unsupported QA AVD ${avd}`);
    if (!avdNames().includes(avd))
      die(`legacy QA AVD ${avd} does not exist; create the pinned fixture first`);
  }
  const wantIos = target === 'ios' || target === 'all';
  const wantAndroid = target === 'android' || target === 'all';
  if (target !== 'ios' && target !== 'android' && target !== 'all') die(`unknown target ${target}`);
  if (wantIos && !IS_MAC && target === 'ios') die('iOS simulators need macOS');

  const exports = [];
  if (wantIos && IS_MAC) {
    const { name, fresh } = claimPoolName('ios', root);
    const udid = await ensureSim(name, { reboot });
    wipeOnFreshClaim('ios', name, fresh, () => wipeIosDevApp(udid));
    info(`ios: ${name} → ${udid}`);
    exports.push(`export SIM=${udid}`);
  } else if (wantIos) {
    info('ios: skipped (not macOS)');
  }
  if (wantAndroid) {
    let claim;
    try {
      claim = avd ? claimNamedAndroid(root, avd) : claimPoolName('android', root);
    } catch (error) {
      die(error.message);
    }
    const { name, fresh } = claim;
    const serial = await ensureAvd(name, { preserveConfig: Boolean(avd), reboot });
    if (avd) {
      // Explicit legacy fixtures preserve their app data and pinned WebView.
      markWiped('android', name);
    } else {
      wipeOnFreshClaim('android', name, fresh, () => wipeAndroidDevApp(serial));
    }
    info(`android: ${name} → ${serial}`);
    exports.push(`export ANDROID_SERIAL=${serial}`);
    exports.push(`export ANDROID_AVD_NAME=${name}`);
  }
  info('claimed for ' + root + ' (slot ' + slotOf(root) + '). Set these in your shell:');
  process.stdout.write(exports.join('\n') + '\n');
}

function myDevices(root) {
  const mine = [];
  if (!fs.existsSync(DEV_DIR)) return mine;
  for (const f of fs.readdirSync(DEV_DIR)) {
    const m = f.match(/^(ios|android)-(.+)\.json$/);
    if (!m) continue;
    const owner = readOwner(m[1], m[2]);
    if (owner?.worktree === root) mine.push({ platform: m[1], name: m[2] });
  }
  return mine;
}

function shutdownDevice(platform, name) {
  if (platform === 'ios') {
    const sim = IS_MAC && findSim(name);
    if (sim && sim.state === 'Booted') tryRun('xcrun', ['simctl', 'shutdown', sim.udid]);
  } else {
    const serial = runningEmus()[name];
    if (serial) tryRun('adb', ['-s', serial, 'emu', 'kill']);
  }
}

// A named platform releases only that platform's claims: two agents QA-ing iOS
// and Android from one worktree must not tear down each other's device. It also
// leaves the sync server up, because a sibling leg may use it without holding
// any device (desktop claims none). A bare release is the last one out and
// stops the server too.
function cmdRelease(flags) {
  const unknownFlag = flags.find((arg) => arg.startsWith('--') && arg !== '--shutdown');
  if (unknownFlag) die(`unknown release option ${unknownFlag}`);
  const positional = flags.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1) die('release accepts at most one platform: ios or android');
  const platform = positional[0];
  if (platform && platform !== 'ios' && platform !== 'android') {
    die(`unknown release platform ${platform}; use ios or android`);
  }
  const shutdown = flags.includes('--shutdown');
  const root = worktreeRoot();
  for (const { platform: claimedPlatform, name } of myDevices(root).filter(
    (device) => !platform || device.platform === platform,
  )) {
    if (shutdown) shutdownDevice(claimedPlatform, name);
    fs.rmSync(ownerPath(claimedPlatform, name), { force: true });
    info(`released ${claimedPlatform} ${name}`);
  }
  if (!platform) serverStop(root, false);
}

function cmdGc() {
  if (fs.existsSync(DEV_DIR)) {
    for (const f of fs.readdirSync(DEV_DIR)) {
      const m = f.match(/^(ios|android)-(.+)\.json$/);
      if (!m) continue;
      const owner = readOwner(m[1], m[2]);
      if (!owner || !ownerIsStale(owner)) continue;
      info(`gc: ${m[1]} ${m[2]} owned by deleted worktree ${owner.worktree}`);
      // Legacy fixture images belong to the developer: gc only releases the claim.
      if (m[1] === 'android' && LEGACY_ANDROID_AVDS.includes(m[2])) {
        fs.rmSync(ownerPath(m[1], m[2]), { force: true });
        continue;
      }
      shutdownDevice(m[1], m[2]);
      if (m[1] === 'ios' && IS_MAC) {
        const sim = findSim(m[2]);
        if (sim) tryRun('xcrun', ['simctl', 'delete', sim.udid]);
      } else if (m[1] === 'android') {
        tryRun(AVDMANAGER, ['delete', 'avd', '-n', m[2]]);
      }
      fs.rmSync(ownerPath(m[1], m[2]), { force: true });
    }
  }
  if (fs.existsSync(SRV_DIR)) {
    for (const d of fs.readdirSync(SRV_DIR)) {
      const meta = readJson(path.join(SRV_DIR, d, 'meta.json'));
      if (meta && !fs.existsSync(meta.worktree)) {
        info(`gc: server ${d} for deleted worktree ${meta.worktree}`);
        stopServerDir(path.join(SRV_DIR, d), meta, true);
      }
    }
  }
  info('gc done');
}

function cmdStatus() {
  const root = worktreeRoot();
  const emus = runningEmus();
  const platforms = IS_MAC ? ['ios', 'android'] : ['android'];
  for (const platform of platforms) {
    info(
      `— ${platform} QA devices (${POOL} pooled${platform === 'android' ? ' + legacy fixtures' : ''}) —`,
    );
    const names = Array.from({ length: POOL }, (_, i) => `futo-qa-${i}`);
    if (platform === 'android') names.push(...LEGACY_ANDROID_AVDS);
    for (const name of names) {
      const owner = readOwner(platform, name);
      let state = 'absent';
      if (platform === 'ios' && IS_MAC) {
        const sim = findSim(name);
        if (sim) state = sim.state === 'Booted' ? `booted ${sim.udid}` : 'shutdown';
      } else if (platform === 'android') {
        if (emus[name]) state = `booted ${emus[name]}`;
        else if (avdNames().includes(name)) state = 'shutdown';
      }
      if (state === 'absent' && !owner) continue;
      const who = owner
        ? `${owner.worktree}${owner.worktree === root ? ' (this worktree)' : ''}${ownerIsStale(owner) ? ' [STALE — qa-gc]' : ''} @ ${owner.branch}`
        : 'unclaimed';
      info(`  ${name}: ${state} — ${who}`);
    }
  }
  info('— sync servers —');
  if (fs.existsSync(SRV_DIR)) {
    for (const d of fs.readdirSync(SRV_DIR).sort()) {
      const meta = readJson(path.join(SRV_DIR, d, 'meta.json'));
      if (!meta) continue;
      const pid = readPid(path.join(SRV_DIR, d, 'server.pid'));
      const alive = pid && pidAlive(pid);
      info(
        `  ${d}: ${alive ? `running pid ${pid} port ${meta.port}` : 'stopped'} — ${meta.worktree}`,
      );
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const USAGE =
  'usage: qa.mjs claim [ios|android|all] [--reboot] [--avd legacy-name] | camera-poster <png> | android-target | android-apk [path] | status | release [ios|android] [--shutdown] | gc | server-start [--standin] | server-stop [--drop] | avd-baseline';
const [cmd, ...args] = process.argv.slice(2);
// Handle help before worktree discovery or invoking any platform tool. A help
// request must never acquire an owner file, boot a device, or wipe app data.
if (cmd === '--help' || cmd === '-h' || args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
switch (cmd) {
  case 'claim': {
    // --reboot forces a simulator shutdown/boot cycle, the only reliable repair
    // for an already-booted sim whose UI reads as a 0x0 root (see ensureSim).
    let avd;
    let reboot = false;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--reboot') reboot = true;
      else if (arg === '--avd') {
        if (avd) die('claim accepts --avd only once');
        avd = args[++i];
        if (!avd || avd.startsWith('-')) die('--avd needs a legacy QA AVD name');
      } else if (arg.startsWith('-')) die(`unknown claim option ${arg}`);
      else positional.push(arg);
    }
    if (positional.length > 1) die('claim accepts at most one platform: ios, android or all');
    await cmdClaim(positional[0] || 'all', { reboot, avd });
    break;
  }
  case 'camera-poster': {
    if (args.length !== 1) die('camera-poster needs one PNG path');
    try {
      const result = await showCameraPoster(args[0]);
      process.stdout.write(
        `export ANDROID_SERIAL=${result.serial}\nexport ANDROID_AVD_NAME=${result.name}\n`,
      );
      info('Camera poster ready; reopen the camera/scanner to load the PNG.');
    } catch (error) {
      die(error.message);
    }
    break;
  }
  case 'android-apk':
    if (args.length > 1) die('android-apk accepts at most one APK path');
    try {
      info(`android APK verified: ${verifyAndroidApk({ apkPath: args[0] })}`);
    } catch (error) {
      die(error.message);
    }
    break;
  case 'android-target':
    if (args.length) die('android-target accepts no arguments');
    try {
      info(`android target verified: ${assertAndroidTarget()}`);
    } catch (error) {
      die(error.message);
    }
    break;
  case 'status':
    cmdStatus();
    break;
  case 'release':
    cmdRelease(args);
    break;
  case 'gc':
    cmdGc();
    break;
  case 'server-start':
    await cmdServerStart(args);
    break;
  case 'server-stop':
    serverStop(worktreeRoot(), args.includes('--drop'));
    break;
  case 'avd-baseline':
    // Re-apply AVD_BASELINE to every pool AVD without booting anything.
    for (let i = 0; i < POOL; i++) applyAvdBaseline(`futo-qa-${i}`);
    break;
  default:
    die(USAGE);
}
