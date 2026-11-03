import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

// Phases after a restart: down (2 calls) -> starting (3 calls: package
// service up, installs still NPE, no enable_screen yet) -> up. State is
// atomically replaced between real executable calls by the bash fixture.
const FAKE_ADB = fs.readFileSync(path.join(root, 'scripts/__fixtures__/ci-android-adb.sh'), 'utf8');

function runSyncLeg({
  restartOnInstall,
  stallAt,
  failAbandon = false,
  interruptStateWrite = false,
  healthyPmDelay = 0,
  slowNodeStartup = false,
}) {
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

  const wait = path.join(dir, 'adb-wait');
  const fifo = spawnSync('mkfifo', [wait], { encoding: 'utf8' });
  expect(fifo.status, fifo.stderr).toBe(0);
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
      interruptStateWrite,
      healthyPmDelay,
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
  // Inject the short deadline only into the one deliberately stalled call.
  // Applying it to every healthy Node child also timed out process startup on
  // loaded CI runners (39067). All other calls retain production deadlines.
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh
case "$1" in */android-package-probe.mjs)
  probe="$1"; shift
  if grep -q '"pmStalled":false' "$FAKE_ADB_STATE"; then
    case "$FAKE_STALL_AT:$*" in
      framework:*"-- list packages"|post-install:*"--installed com.futo.notes.dev")
        exec "${process.execPath}" "$probe" --timeout-ms 250 "$@" ;;
    esac
  fi
  exec "${process.execPath}" "$probe" "$@" ;;
*) exec "${process.execPath}" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'xvfb-run'),
    `#!/bin/sh\nprintf '%s\\n' "$*" > '${harnessArgs}'\n`,
    {
      mode: 0o755,
    },
  );

  // Model interpreter startup under a contended runner without burning CPU
  // or extending any probe/test deadline. This is inherited by real probe
  // processes and executable fake adb children alike.
  const startupDelay = path.join(dir, 'node-startup-delay.cjs');
  fs.writeFileSync(
    startupDelay,
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);\n',
  );

  const result = spawnSync('bash', [path.join(project, 'scripts/ci-android-sync-leg.sh')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ...(slowNodeStartup
        ? {
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(startupDelay)}`]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CI_PROJECT_DIR: project,
      ANDROID_HOME: sdk,
      FAKE_ADB_STATE: state,
      FAKE_ADB_WAIT: wait,
      FAKE_EMULATOR_PID: emulatorPid,
      FAKE_STALL_AT: stallAt ?? '',
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
    stateWriteInterrupted: fs.existsSync(state + '.interrupted'),
    harness: fs.existsSync(harnessArgs) ? fs.readFileSync(harnessArgs, 'utf8') : null,
  };
}

// Every case spawns the real script under spawnSync's own 60s bound, which is
// the real budget. Vitest's 5s default timed out the slow-Node-startup case on
// a loaded CI runner (pipeline 39298), so the file timeout sits just above it.
vi.setConfig({ testTimeout: 70_000 });

describe('native-Android sync leg against a framework that restarts after boot', () => {
  it('keeps healthy package operations independent of the injected stalled-probe deadline', () => {
    const run = runSyncLeg({ restartOnInstall: [], healthyPmDelay: 300 });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.adb.installAttempts).toBe(1);
    expect(run.harness).toContain('--android-only');
  });
  it('recovers when a readiness deadline interrupts the fake adb state write', () => {
    const run = runSyncLeg({
      restartOnInstall: [],
      stallAt: 'framework',
      interruptStateWrite: true,
    });
    expect(run.stateWriteInterrupted).toBe(true);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.adb.pmStalled).toBe(true);
    expect(run.adb.pmCompleted).toBe(false);
    expect(run.harness).toContain('--android-only');
  }, 20_000);
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

  it('recovers one framework restart within the test budget when Node startup is slow', () => {
    const run = runSyncLeg({ restartOnInstall: [1], slowNodeStartup: true });

    expect(run.status, run.stdout + run.stderr).toBe(0);
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
