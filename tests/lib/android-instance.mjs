/**
 * Android emulator-backed Tauri instance for cross-platform sync tests.
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, openSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWs, sleep } from './mcp-client.mjs';
import { TauriTestClient, waitForTestHooks } from './tauri-test-client.mjs';

const APP_ID = 'com.futo.notes';
const ANDROID_PREVIEW_PORT = 5181;
const MCP_PORT_START = 9223;
const MCP_PORT_END = 9322;
let previewServer = null;

export async function startAndroidEmulatorInstance(name, repoRoot) {
  const emulatorBinary = resolveEmulatorBinary();
  ensureCommandExists('adb', 'adb not found in PATH');

  const emulator = await pickOrStartEmulator(name, emulatorBinary);
  const preview = await ensureAndroidPreviewServer(repoRoot);

  runChecked('adb', ['-s', emulator.serial, 'wait-for-device']);
  await waitForBootCompleted(emulator.serial);
  await waitForPackageManager(emulator.serial);
  const apkPath = findDebugApk(repoRoot, emulator.serial);
  runChecked('adb', ['-s', emulator.serial, 'shell', 'pm', 'clear', APP_ID], { allowFailure: true });
  installApk(emulator.serial, apkPath);
  runChecked('adb', ['-s', emulator.serial, 'reverse', `tcp:${ANDROID_PREVIEW_PORT}`, `tcp:${ANDROID_PREVIEW_PORT}`]);
  runChecked('adb', ['-s', emulator.serial, 'shell', 'am', 'force-stop', APP_ID], { allowFailure: true });
  runChecked('adb', ['-s', emulator.serial, 'shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);

  const forward = await connectAndroidBridge(emulator.serial);
  const ws = await connectWs(forward.localPort, 10_000);
  await waitForTestHooks(ws, name, {
    initialDelayMs: 5_000,
    attempts: 45,
    intervalMs: 2_000,
  });

  return new TauriTestClient({
    name,
    platform: 'android-emulator',
    ws,
    port: forward.localPort,
    proc: emulator.proc ?? null,
    loopbackHost: '10.0.2.2',
    stopProc: () => {
      removePortForward(emulator.serial, forward.localPort);
      runChecked('adb', ['-s', emulator.serial, 'reverse', '--remove', `tcp:${ANDROID_PREVIEW_PORT}`], { allowFailure: true });
      if (emulator.startedByHarness) {
        runChecked('adb', ['-s', emulator.serial, 'emu', 'kill'], { allowFailure: true });
      }
      preview.release();
    },
  });
}

function findDebugApk(repoRoot, serial) {
  const apkDir = join(repoRoot, 'apps', 'tauri', 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
  accessSync(apkDir);
  const candidates = collectFiles(apkDir).filter((path) => path.endsWith('.apk') && path.includes('debug'));
  if (candidates.length === 0) {
    throw new Error('Android debug APK not found. Run: cd apps/tauri && VITE_INCLUDE_TEST_HOOKS=true cargo tauri android build --debug --apk --config src-tauri/tauri.android.dev-mode.conf.json');
  }
  const abi = getDeviceAbi(serial);
  // Pick newest APK within each preference bucket so that stale per-ABI builds
  // don't shadow a just-rebuilt universal APK (or vice versa).
  const byMtime = (paths) => paths
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.p);
  const abiMatches = byMtime(candidates.filter((p) => p.includes(`/${abi}/`) || p.includes(`-${abi}-`)));
  const universalMatches = byMtime(candidates.filter((p) => p.includes('universal')));
  const rest = byMtime(candidates);
  // Prefer whichever bucket has a newer APK — avoids installing a stale per-ABI
  // APK when the user just rebuilt universal (or vice versa).
  const picks = [abiMatches[0], universalMatches[0], rest[0]].filter(Boolean);
  const preferred = byMtime(picks)[0];
  return preferred;
}

function getDeviceAbi(serial) {
  const abi = runChecked('adb', ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi']).stdout.trim();
  return abi || 'x86_64';
}

function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function pickOrStartEmulator(name, emulatorBinary) {
  const online = listOnlineEmulators();
  const preferredSerial = process.env.ANDROID_SERIAL;
  if (preferredSerial && online.includes(preferredSerial)) {
    return { serial: preferredSerial, proc: null, startedByHarness: false };
  }
  if (online.length > 0) {
    return { serial: online[0], proc: null, startedByHarness: false };
  }

  const avdName = selectAvd(emulatorBinary);
  const logFile = join(tmpdir(), `android-emulator-${name}-${Date.now()}.log`);
  const logFd = openSync(logFile, 'w');
  const args = ['-avd', avdName, '-no-snapshot-load', '-no-boot-anim'];
  if (process.env.CI) {
    const gpu = process.env.SF_ANDROID_KVM ? 'auto' : 'swiftshader_indirect';
    args.push('-no-window', '-gpu', gpu, '-no-audio');
  }
  const proc = spawn(emulatorBinary, args, {
    stdio: ['ignore', logFd, logFd],
  });

  const serial = await waitForNewEmulatorSerial(120_000);
  return { serial, proc, startedByHarness: true };
}

function selectAvd(emulatorBinary) {
  const preferred = process.env.SF_ANDROID_AVD;
  const avds = runChecked(emulatorBinary, ['-list-avds']).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (preferred) {
    if (!avds.includes(preferred)) {
      throw new Error(`Requested SF_ANDROID_AVD=${preferred} not found. Available AVDs: ${avds.join(', ')}`);
    }
    return preferred;
  }

  if (avds.length === 0) {
    throw new Error('No Android emulators are defined. Create an AVD or set SF_ANDROID_AVD.');
  }

  return avds[0];
}

function listOnlineEmulators() {
  const output = runChecked('adb', ['devices']).stdout;
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([serial, status]) => serial.startsWith('emulator-') && status === 'device')
    .map(([serial]) => serial);
}

async function waitForNewEmulatorSerial(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const emulators = listOnlineEmulators();
    if (emulators.length > 0) return emulators[0];
    await sleep(2_000);
  }
  throw new Error(`Android emulator did not come online after ${timeoutMs}ms`);
}

async function waitForBootCompleted(serial, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const boot = runChecked('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { allowFailure: true }).stdout.trim();
    if (boot === '1') return;
    await sleep(2_000);
  }
  throw new Error(`Android emulator ${serial} did not finish booting after ${timeoutMs}ms`);
}

async function waitForPackageManager(serial, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = runChecked('adb', ['-s', serial, 'shell', 'pm', 'path', 'android'], { allowFailure: true }).stdout.trim();
    if (result.includes('package:')) return;
    await sleep(2_000);
  }
  throw new Error(`Android emulator ${serial} package manager was not ready after ${timeoutMs}ms`);
}

async function connectAndroidBridge(serial, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let remotePort = MCP_PORT_START; remotePort <= MCP_PORT_END; remotePort += 1) {
      const localPort = await findFreePort();
      runChecked('adb', ['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${remotePort}`], { allowFailure: true });
      try {
        const ws = await connectWs(localPort, 2_500);
        ws.close();
        return { localPort, remotePort };
      } catch {
        removePortForward(serial, localPort);
      }
    }
    await sleep(2_000);
  }

  throw new Error(`Could not find an Android MCP bridge port on ${serial} after ${timeoutMs}ms`);
}

function installApk(serial, apkPath) {
  const first = runChecked('adb', ['-s', serial, 'install', '-r', apkPath], { allowFailure: true });
  if (first.status === 0) return;

  const installOutput = `${first.stdout}\n${first.stderr}`;
  if (!/not enough space/i.test(installOutput)) {
    throw formatCommandFailure('adb', ['-s', serial, 'install', '-r', apkPath], first);
  }

  runChecked('adb', ['-s', serial, 'uninstall', APP_ID], { allowFailure: true });
  const retry = runChecked('adb', ['-s', serial, 'install', apkPath], { allowFailure: true });
  if (retry.status === 0) return;
  throw formatCommandFailure('adb', ['-s', serial, 'install', apkPath], retry);
}

async function ensureAndroidPreviewServer(repoRoot) {
  if (previewServer) {
    previewServer.refCount += 1;
    return previewServer;
  }

  // Kill any stale process still holding the preview port. The harness should
  // bootstrap cleanly even if a previous run was interrupted.
  killPortHolders(ANDROID_PREVIEW_PORT);

  const logFile = join(tmpdir(), `android-preview-${Date.now()}.log`);
  const logFd = openSync(logFile, 'w');
  const proc = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(ANDROID_PREVIEW_PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: ['ignore', logFd, logFd],
  });

  await waitForPreviewServer();

  previewServer = {
    proc,
    refCount: 1,
    release() {
      if (!previewServer) return;
      previewServer.refCount -= 1;
      if (previewServer.refCount <= 0) {
        try { previewServer.proc.kill('SIGTERM'); } catch { /* ignore */ }
        previewServer = null;
      }
    },
  };

  return previewServer;
}

async function waitForPreviewServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${ANDROID_PREVIEW_PORT}/`);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }

  throw new Error(`Android preview server on 127.0.0.1:${ANDROID_PREVIEW_PORT} did not become ready after ${timeoutMs}ms`);
}

function removePortForward(serial, localPort) {
  runChecked('adb', ['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { allowFailure: true });
}

function killPortHolders(port) {
  const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  const pids = (lsof.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
  if (pids.length > 0) {
    // Give kernels a beat to release the socket.
    const start = Date.now();
    while (Date.now() - start < 2_000) {
      const recheck = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
      if (!recheck.stdout?.trim()) return;
    }
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate local port for adb forward')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function resolveEmulatorBinary() {
  const candidates = [
    process.env.ANDROID_EMULATOR_BIN,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'emulator', 'emulator') : null,
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'emulator', 'emulator') : null,
    join(process.env.HOME ?? '', 'Android', 'Sdk', 'emulator', 'emulator'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }

  ensureCommandExists('emulator', 'Android emulator binary not found in PATH or Android SDK env vars');
  return 'emulator';
}

function ensureCommandExists(command, message) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(message);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });

  if (result.status !== 0 && !options.allowFailure) {
    throw formatCommandFailure(command, args, result);
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function formatCommandFailure(command, args, result) {
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  return new Error(
    `${command} ${args.join(' ')} failed` +
    (stderr ? `\nstderr: ${stderr}` : '') +
    (stdout ? `\nstdout: ${stdout}` : ''),
  );
}
