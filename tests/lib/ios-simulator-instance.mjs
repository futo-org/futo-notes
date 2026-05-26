/**
 * iOS Simulator-backed Tauri instance for cross-platform tests.
 *
 * Mirrors `android-instance.mjs` but uses `xcrun simctl` instead of `adb`.
 * The iOS simulator shares the host's TCP stack, so the MCP bridge port the
 * app picks (in range 9223–9322) is reachable at 127.0.0.1:<port> from the
 * host. We discover it by snapshotting listening ports in that range before
 * launching the app and finding the new entry afterwards — robust even when
 * a sibling macOS Tauri instance is already holding 9223.
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, mkdtempSync, openSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { connectWs, sleep } from './mcp-client.mjs';
import { TauriTestClient, waitForTestHooks } from './tauri-test-client.mjs';

const APP_ID = 'com.futo.notes.dev';
const MCP_PORT_START = 9223;
const MCP_PORT_END = 9322;
// Where `cargo tauri ios build --target aarch64-sim` drops the .app bundle.
// The product name comes from tauri.ios.dev.conf.json (productName "FUTO Notes Dev")
// → the bundle dir is "FUTO Notes Dev.app".
const APP_BUNDLE_NAME = 'FUTO Notes Dev.app';

/**
 * Boot or reuse an iOS simulator, install the freshly-built debug .app,
 * launch it, and connect the Tauri MCP bridge.
 *
 * @param {string} name Instance label (used in log paths and error messages).
 * @param {string} repoRoot Absolute path to the monorepo root.
 * @returns {Promise<TauriTestClient>}
 */
export async function startIosSimulatorInstance(name, repoRoot) {
  ensureCommandExists('xcrun', 'xcrun not found — install Xcode command-line tools');

  const udid = await pickOrBootSimulator(name);
  const appPath = findSimulatorApp(repoRoot);

  // Per-instance data dir so two iOS sim instances don't clobber each other's
  // notes-dir-override.json. Tauri's FUTO_NOTES_DATA_DIR env var doesn't make
  // it through `simctl launch`'s env, so we pass it via the app's container
  // (TAURI_DEV_ env vars aren't read on iOS either). Instead we just rely on
  // simctl's per-app container — each install of com.futo.notes.dev gets its
  // own ~/Documents.
  //
  // To support multiple iOS instances we'd need distinct bundle IDs; not
  // needed for the macOS↔iOS regression suite where only one iOS instance runs.
  runChecked('xcrun', ['simctl', 'terminate', udid, APP_ID], { allowFailure: true });
  installApp(udid, appPath);

  // Snapshot ports BEFORE launch so we can identify the new one after.
  const portsBefore = listeningPortsInRange(MCP_PORT_START, MCP_PORT_END);

  const logFile = join(tmpdir(), `ios-${name}-${Date.now()}.log`);
  launchApp(udid, APP_ID, logFile);

  const port = await waitForNewListeningPort(portsBefore, 60_000);
  let ws;
  try {
    ws = await connectWs(port, 15_000);
    await waitForTestHooks(ws, name, { initialDelayMs: 5_000, attempts: 45, intervalMs: 2_000 });
  } catch (err) {
    runChecked('xcrun', ['simctl', 'terminate', udid, APP_ID], { allowFailure: true });
    throw new Error(`${name}: iOS startup failed — ${err.message}`);
  }

  return new TauriTestClient({
    name,
    platform: 'ios-simulator',
    ws,
    port,
    logFile,
    // iOS simulator shares the host's network stack, so 127.0.0.1 is what
    // both the host and the sim use to reach localhost services.
    loopbackHost: '127.0.0.1',
    stopProc: () => {
      runChecked('xcrun', ['simctl', 'terminate', udid, APP_ID], { allowFailure: true });
    },
  });
}

// ── Simulator lifecycle ────────────────────────────────────────────

async function pickOrBootSimulator(name) {
  const preferredUdid = process.env.SF_IOS_UDID;
  const booted = listBootedSimulators();

  if (preferredUdid) {
    if (booted.includes(preferredUdid)) return preferredUdid;
    runChecked('xcrun', ['simctl', 'boot', preferredUdid]);
    await waitForBootCompleted(preferredUdid);
    return preferredUdid;
  }

  if (booted.length > 0) return booted[0];

  const udid = pickDefaultSimulator();
  if (!udid) {
    throw new Error('No iOS simulator available. Install a runtime via Xcode or set SF_IOS_UDID.');
  }
  runChecked('xcrun', ['simctl', 'boot', udid]);
  await waitForBootCompleted(udid);
  return udid;
}

function listBootedSimulators() {
  const out = runChecked('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).stdout;
  try {
    const data = JSON.parse(out);
    const udids = [];
    for (const runtime of Object.values(data.devices ?? {})) {
      for (const device of runtime) {
        if (device.state === 'Booted' && device.udid) udids.push(device.udid);
      }
    }
    return udids;
  } catch {
    return [];
  }
}

function pickDefaultSimulator() {
  const out = runChecked('xcrun', ['simctl', 'list', 'devices', 'available', '-j']).stdout;
  try {
    const data = JSON.parse(out);
    // Prefer the newest iOS runtime, newest iPhone model.
    const runtimes = Object.keys(data.devices ?? {})
      .filter((rt) => rt.includes('iOS'))
      .sort()
      .reverse();
    for (const rt of runtimes) {
      const devices = (data.devices[rt] ?? []).filter((d) => d.isAvailable && d.name.toLowerCase().includes('iphone'));
      if (devices.length > 0) {
        // Newest model name sorts last by convention; reverse and take first.
        devices.sort((a, b) => a.name.localeCompare(b.name));
        return devices[devices.length - 1].udid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function waitForBootCompleted(udid, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = runChecked('xcrun', ['simctl', 'bootstatus', udid], { allowFailure: true });
    // `bootstatus` exits 0 once the device finishes booting.
    if (result.status === 0) return;
    await sleep(2_000);
  }
  throw new Error(`Simulator ${udid} did not finish booting after ${timeoutMs}ms`);
}

// ── App build + install ───────────────────────────────────────────

function findSimulatorApp(repoRoot) {
  // `cargo tauri ios build --target aarch64-sim` puts the .app in
  // apps/tauri/src-tauri/gen/apple/build/Build/Products/debug-iphonesimulator/
  // (Xcode-managed) — verify and fall back if Xcode moved it.
  const candidates = [
    join(repoRoot, 'apps/tauri/src-tauri/gen/apple/build/Build/Products/debug-iphonesimulator', APP_BUNDLE_NAME),
    join(repoRoot, 'apps/tauri/src-tauri/gen/apple/build/arm64-sim', APP_BUNDLE_NAME),
  ];
  for (const candidate of candidates) {
    try { accessSync(candidate); return candidate; } catch { /* try next */ }
  }
  // Last resort: search the gen/apple tree for a matching bundle.
  const found = findAppBundle(join(repoRoot, 'apps/tauri/src-tauri/gen/apple'));
  if (found) return found;
  throw new Error(
    `iOS simulator .app bundle not found. Run:\n` +
    `  cd apps/tauri && VITE_INCLUDE_TEST_HOOKS=true \\\n` +
    `    cargo tauri ios build --debug --target aarch64-sim \\\n` +
    `    --config src-tauri/tauri.ios.dev.conf.json`,
  );
}

function findAppBundle(root) {
  let best = null;
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === APP_BUNDLE_NAME) {
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: full, mtime };
        // Don't recurse into .app
        continue;
      }
      walk(full);
    }
  }
  walk(root);
  return best?.path ?? null;
}

function installApp(udid, appPath) {
  runChecked('xcrun', ['simctl', 'install', udid, appPath]);
}

function launchApp(udid, bundleId, logFile) {
  const logFd = openSync(logFile, 'w');
  // `simctl launch --stdout=... --stderr=...` (Xcode 14+) redirects the app's
  // stdout/stderr to the given files. The MCP bridge prints its bind port via
  // println!, so the log file will contain a line like:
  //   [MCP][bridge][INFO] MCP Bridge plugin initialized for '...' on 0.0.0.0:9224
  // We don't depend on parsing that line — the port-snapshot trick is more
  // reliable — but capturing logs is useful for debugging startup failures.
  runChecked('xcrun', [
    'simctl', 'launch',
    `--stdout=${logFile}`,
    `--stderr=${logFile}`,
    '--terminate-running-process',
    udid,
    bundleId,
  ]);
  // logFd handle is no longer needed once simctl owns the file.
  try { /* nothing — file is owned by simctl now */ } finally { /* keep fd open if needed */ void logFd; }
}

// ── Port discovery via snapshot diff ──────────────────────────────

function listeningPortsInRange(start, end) {
  // `lsof -iTCP -sTCP:LISTEN -P -n` lists every listening socket on the host.
  // We filter by port range. On macOS this returns ports bound by simulator
  // apps too (they live in the host's network namespace).
  const out = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { encoding: 'utf8' });
  const ports = new Set();
  for (const line of (out.stdout || '').split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= start && port <= end) ports.add(port);
  }
  return ports;
}

async function waitForNewListeningPort(before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = listeningPortsInRange(MCP_PORT_START, MCP_PORT_END);
    for (const port of now) {
      if (before.has(port)) continue;
      // New port — confirm it's actually a WebSocket by attempting a connection.
      try {
        const ws = await connectWs(port, 2_000);
        ws.close();
        return port;
      } catch {
        // Not a usable WS — keep looking.
      }
    }
    await sleep(1_000);
  }
  throw new Error(`No new listening port appeared in ${MCP_PORT_START}-${MCP_PORT_END} within ${timeoutMs}ms`);
}

// ── Shell helpers (same shape as android-instance.mjs) ────────────

function ensureCommandExists(command, message) {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(message);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
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
