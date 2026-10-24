import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// Drives the real CI script (ci-android-sync-leg.sh sourcing
// ci-android-emulator.sh) against a fake emulator whose Android framework
// restarts the way CI's did: system_server dies after sys.boot_completed reads
// 1 (the property stays 1), every package call fails while it is down, and the
// new process takes installs only once it has logged boot_progress_enable_screen
// under its own pid. `sleep` is a no-op so the polls cost nothing.

const root = path.resolve(import.meta.dirname, '..');
const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// One process per call; state lives in a JSON file between calls. Phases after
// a restart: down (2 calls) -> starting (3 calls: package service up, installs
// still NPE, no enable_screen yet) -> up.
const FAKE_ADB = String.raw`#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_ADB_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
let args = process.argv.slice(2);
if (args[0] === '-s') args = args.slice(2);
st.sinceRestart += 1;
if (st.phase === 'down' && st.sinceRestart > 2) st.phase = 'starting';
if (st.phase === 'starting' && st.sinceRestart > 5) {
  st.phase = 'up';
  st.booted.push(st.pid);
}
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const out = (s, code = 0) => { save(); if (s) process.stdout.write(s + '\n'); process.exit(code); };
const gone = "cmd: Can't find service: package";
const cmd = args.join(' ');
if (cmd === 'get-state') {
  if (st.pmStalled) st.transportProbesAfterStall += 1;
  out('device');
}
if (cmd === 'emu avd name') out('ci\nOK');
if (cmd === 'emu kill') out('');
if (cmd === 'shell getprop sys.boot_completed') out('1');
if (cmd === 'shell getprop sys.system_server.start_count') out(String(st.generation));
if (cmd === 'shell pidof system_server') st.phase === 'down' ? out('', 1) : out(String(st.pid));
if (cmd === 'shell service check package') out(st.phase === 'down' ? 'Service package: not found' : 'Service package: found');
if (cmd.startsWith('shell pm list packages')) {
  const respond = () => st.phase === 'down' ? out(gone, 1) : out('package:android' + (st.installed ? '\npackage:com.futo.notes.dev' : ''));
  const shouldStall = !st.pmStalled && (st.stallAt === 'framework' ? !st.installed : st.stallAt === 'post-install' && st.installed);
  if (shouldStall) {
    st.pmStalled = true;
    save();
    setTimeout(() => { st.pmCompleted = true; respond(); }, 6500);
  } else respond();
} else {
if (cmd === 'shell pm install-create') st.phase === 'down' ? out(gone, 1) : out('Success: created install session [42]');
if (cmd.startsWith('shell pm install-abandon')) out(st.failAbandon ? 'Failure: cleanup failed' : 'Success', st.failAbandon ? 1 : 0);
if (cmd === 'logcat -b events -d -v threadtime') {
  out(st.booted.map((pid) => '10-08 16:10:21.794  ' + pid + '  ' + (pid + 1) + ' I boot_progress_enable_screen: 1234').join('\n'));
}
if (args[0] === 'logcat') out('');
if (args[0] === 'install') {
  st.installAttempts += 1;
  if (st.restartOnInstall.includes(st.installAttempts)) {
    st.generation += 1;
    st.pid += 100;
    st.phase = 'down';
    st.sinceRestart = 0;
    out('Performing Streamed Install\nadb: failed to install ' + args.at(-1) + ': ' + gone, 1);
  }
  if (st.phase !== 'up') {
    out("Exception occurred while executing 'install':\njava.lang.NullPointerException: Attempt to invoke virtual method 'void android.content.pm.PackageManagerInternal.freeStorage(java.lang.String, long, int)' on a null object reference", 1);
  }
  st.installed = true;
  out('Performing Streamed Install\nSuccess');
}
out('fake adb: unhandled ' + cmd, 2);
}
`;

function runSyncLeg({ restartOnInstall, stallAt, failAbandon = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-sync-leg-'));
  scratch.push(dir);
  const bin = path.join(dir, 'bin');
  const sdk = path.join(dir, 'sdk');
  const project = path.join(dir, 'project');
  for (const sub of [bin, path.join(sdk, 'platform-tools'), path.join(sdk, 'emulator')]) {
    fs.mkdirSync(sub, { recursive: true });
  }
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  for (const script of ['ci-android-sync-leg.sh', 'ci-android-emulator.sh']) {
    fs.symlinkSync(path.join(root, 'scripts', script), path.join(project, 'scripts', script));
  }
  fs.mkdirSync(path.join(project, 'scripts/qa'), { recursive: true });
  fs.symlinkSync(
    path.join(root, 'scripts/qa/android-package-probe.mjs'),
    path.join(project, 'scripts/qa/android-package-probe.mjs'),
  );
  const apkDir = path.join(project, 'apps/android/app/build/outputs/apk/direct/debug');
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(apkDir, 'app-direct-debug.apk'), 'apk');

  const state = path.join(dir, 'adb-state.json');
  fs.writeFileSync(
    state,
    JSON.stringify({
      generation: 1,
      pid: 501,
      phase: 'up',
      sinceRestart: 0,
      booted: [501],
      installed: false,
      installAttempts: 0,
      restartOnInstall,
      stallAt,
      pmStalled: false,
      pmCompleted: false,
      transportProbesAfterStall: 0,
      failAbandon,
    }),
  );
  const harnessArgs = path.join(dir, 'harness-args');
  const emulatorPid = path.join(dir, 'emulator-pid');
  fs.writeFileSync(path.join(sdk, 'platform-tools', 'adb'), FAKE_ADB, { mode: 0o755 });
  fs.writeFileSync(
    path.join(sdk, 'emulator', 'emulator'),
    '#!/bin/sh\nprintf "%s" "$$" > "$FAKE_EMULATOR_PID"\nexec /bin/sleep 60\n',
    {
      mode: 0o755,
    },
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'xvfb-run'),
    `#!/bin/sh\nprintf '%s\\n' "$*" > '${harnessArgs}'\n`,
    {
      mode: 0o755,
    },
  );

  const result = spawnSync('bash', [path.join(project, 'scripts/ci-android-sync-leg.sh')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CI_PROJECT_DIR: project,
      ANDROID_HOME: sdk,
      FAKE_ADB_STATE: state,
      FAKE_EMULATOR_PID: emulatorPid,
      ANDROID_CI_AVD: 'ci',
    },
  });
  let emulatorStopped = true;
  if (fs.existsSync(emulatorPid)) {
    try {
      process.kill(Number(fs.readFileSync(emulatorPid, 'utf8')), 0);
      emulatorStopped = false;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  expect(emulatorStopped, 'the CI script left its owned fake emulator running').toBe(true);
  return {
    ...result,
    adb: JSON.parse(fs.readFileSync(state, 'utf8')),
    harness: fs.existsSync(harnessArgs) ? fs.readFileSync(harnessArgs, 'utf8') : null,
  };
}

describe('native-Android sync leg against a framework that restarts after boot', () => {
  it('fails instead of accepting a readiness session that was not abandoned', () => {
    const run = runSyncLeg({ restartOnInstall: [], failAbandon: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('cannot abandon readiness install session');
    expect(run.adb.installAttempts).toBe(0);
    expect(run.harness).toBeNull();
  });
  it('bounds a stalled readiness query and distinguishes the responding adb transport', () => {
    const run = runSyncLeg({ restartOnInstall: [], stallAt: 'framework' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.adb.pmStalled).toBe(true);
    expect(run.adb.pmCompleted).toBe(false);
    expect(run.adb.transportProbesAfterStall).toBeGreaterThan(0);
    expect(run.harness).toContain('--android-only');
  }, 20_000);

  it('reports post-install PM timeouts as unknown presence and never starts the harness', () => {
    const run = runSyncLeg({ restartOnInstall: [], stallAt: 'post-install' });
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/Package Manager.*timed out[\s\S]*get-state=device/);
    expect(run.stderr).not.toContain('is not installed after adb install');
    expect(run.adb.pmCompleted).toBe(false);
    expect(run.harness).toBeNull();
  }, 20_000);

  it('installs once and starts the harness when the framework stays up', () => {
    const run = runSyncLeg({ restartOnInstall: [] });

    expect(run.status, run.stderr).toBe(0);
    expect(run.adb.installAttempts).toBe(1);
    expect(run.harness).toContain('--android-only');
  });

  it('waits out a restart that lands on the install, then installs once more', () => {
    const run = runSyncLeg({ restartOnInstall: [1] });

    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('Android framework restarted during adb install');
    // Two attempts, the second only after the new system_server booted: an
    // install in its "starting" window would have hit the freeStorage NPE.
    expect(run.adb.installAttempts).toBe(2);
    expect(run.adb.installed).toBe(true);
    expect(run.harness).toContain('--android-only');
  });

  it('fails red without running the harness when the framework restarts on the retry too', () => {
    const run = runSyncLeg({ restartOnInstall: [1, 2] });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('restarted again during the retried install');
    expect(run.adb.installAttempts).toBe(2);
    expect(run.harness).toBeNull();
  });
});
