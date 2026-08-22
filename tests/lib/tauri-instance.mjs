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
    // This harness deliberately assumes the REPO-LOCAL target/ — see
    // REMOTE_CARGO_TARGET_DIR in scripts/remote-test.mjs for why the repo does
    // not relocate it. With CARGO_TARGET_DIR exported, cargo writes the binary
    // somewhere else and this used to fail as a bare "not found" AFTER an
    // 84-second build, naming nothing (pc_f7e52544227e). Say what is actually
    // going on.
    const relocated = process.env.CARGO_TARGET_DIR;
    throw new Error(
      [
        `Debug binary not found. Looked in:`,
        ...candidates.map((c) => `  ${c}`),
        relocated
          ? `\nCARGO_TARGET_DIR is set to '${relocated}', so cargo put the binary there ` +
            `instead. This harness (and cross-platform-sync.mjs's pgrep cleanup, which only ` +
            `kills binaries under the repo-local target/) requires the repo-local path — ` +
            `unset CARGO_TARGET_DIR and re-run.`
          : `\nRun: cd apps/tauri && cargo tauri build --debug --no-bundle`,
      ].join('\n'),
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
    // Probe immediately: the MCP bridge often becomes discoverable only after
    // the webview is already ready. Retries preserve the same 90s CI budget
    // without charging every successful launch a fixed five-second delay.
    await waitForTestHooks(ws, name, { initialDelayMs: 0, attempts: 45, intervalMs: 2_000 });
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
