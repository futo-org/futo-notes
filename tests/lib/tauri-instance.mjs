/**
 * Desktop Tauri instance launcher for cross-platform sync tests.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, accessSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPort, connectWs } from './mcp-client.mjs';
import { TauriTestClient, waitForTestHooks } from './tauri-test-client.mjs';

export async function startDesktopTauriInstance(name, repoRoot) {
  const dataDir = mkdtempSync(join(tmpdir(), `sf-${name}-`));
  const notesDir = mkdtempSync(join(tmpdir(), `sf-notes-${name}-`));

  writeFileSync(join(dataDir, 'notes-dir-override.json'), JSON.stringify({ notesDir }));

  const logFile = join(tmpdir(), `tauri-${name}-${Date.now()}.log`);
  const logFd = openSync(logFile, 'w');

  const candidates = [
    join(repoRoot, 'target', 'debug', 'futo-notes-tauri'),
    join(repoRoot, 'apps', 'tauri', 'src-tauri', 'target', 'debug', 'futo-notes-tauri'),
  ];
  let binaryPath;
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      binaryPath = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  if (!binaryPath) {
    throw new Error(
      'Debug binary not found. Run: cd apps/tauri && cargo tauri build --debug --no-bundle',
    );
  }

  const proc = spawn(binaryPath, [], {
    env: {
      ...process.env,
      FUTO_NOTES_DATA_DIR: dataDir,
      FUTO_NOTES_MULTI_INSTANCE: '1',
      WEBKIT_DISABLE_DMABUF_RENDERER: '1',
    },
    stdio: ['ignore', logFd, logFd],
  });

  let port;
  try {
    port = await discoverPort(logFile, 60_000);
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`${name}: MCP bridge port not found — ${err.message}`);
  }

  let ws;
  try {
    ws = await connectWs(port);
    // 95s budget matches android-instance — CI runners can take much longer
    // than a dev laptop to fully boot the webview and attach the test hooks.
    await waitForTestHooks(ws, name, { initialDelayMs: 5_000, attempts: 45, intervalMs: 2_000 });
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`${name}: desktop startup failed — ${err.message}`);
  }

  return new TauriTestClient({
    name,
    platform: 'desktop',
    proc,
    ws,
    port,
    notesDir,
    dataDir,
    logFile,
  });
}

export const startTauriInstance = startDesktopTauriInstance;
