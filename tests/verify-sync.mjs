#!/usr/bin/env node
/**
 * Feature verification for sync (invoked by /verify that sync still works).
 *
 * Assumes a sync server and Tauri instance are already running (the /verify
 * skill owns server/Tauri lifecycle). Discovers the MCP bridge port from the
 * tauri log file, connects via the shared mcp-client helper, and drives
 * window.__testSync through a connect → create note → syncNow → verify cycle.
 */

import { connectWs, executeJs, send, sleep } from './lib/mcp-client.mjs';

const SERVER_URL = process.env.VERIFY_SERVER_URL;
const MCP_PORT = Number(process.env.MCP_PORT || 9223);
const PASSWORD = 'testing123';

if (!SERVER_URL) {
  console.error('Set VERIFY_SERVER_URL (e.g., http://localhost:3128)');
  process.exit(1);
}

function log(step, payload) {
  console.log(`[verify-sync] ${step}: ${JSON.stringify(payload)}`);
}

async function main() {
  const ws = await connectWs(MCP_PORT);
  console.log(`[verify-sync] connected to MCP bridge on :${MCP_PORT}`);

  // Wait for the dev-only test hook to land on window.
  for (let i = 0; i < 30; i++) {
    const ready = await executeJs(ws, 'typeof window.__testSync === "object"');
    if (ready === true) break;
    await sleep(1000);
  }

  // Connect to the isolated sync server.
  const connected = await executeJs(
    ws,
    `(async () => { try { return await window.__testSync.connect(${JSON.stringify(SERVER_URL)}, ${JSON.stringify(PASSWORD)}); } catch (e) { return { error: String(e && e.message || e) }; } })()`,
  );
  log('connect', connected);
  if (connected && connected.error) throw new Error(`connect failed: ${connected.error}`);

  // Create a note so there's something to push.
  const noteTitle = `verify-sync-${Date.now()}`;
  const created = await executeJs(
    ws,
    `(async () => { const m = await import('/src/features/notes/notes.svelte.ts'); const r = await m.createNote(${JSON.stringify(noteTitle)}, '# Hello\\nTest body for sync verification'); return r; })()`,
  );
  log('createNote', created);

  // Trigger sync.
  const syncResult = await executeJs(
    ws,
    `(async () => { try { return await window.__testSync.syncNow(); } catch (e) { return { error: String(e && e.message || e) }; } })()`,
  );
  log('syncNow', syncResult);
  if (syncResult && syncResult.error) throw new Error(`syncNow failed: ${syncResult.error}`);

  const summary = syncResult.summary || {};
  const pushed = (summary.uploaded ?? 0) + (summary.updated ?? 0);
  console.log(`[verify-sync] sync summary: ${JSON.stringify(summary)}`);
  if (pushed < 1) throw new Error(`expected at least 1 uploaded, got ${pushed}`);

  const status = await executeJs(ws, 'window.__testSync.status()');
  log('status', {
    lastSyncedAt: status?.preferences?.sync?.lastSyncedAt,
    serverUrl: status?.appState?.e2eeServerUrl,
    hasToken: Boolean(status?.appState?.e2eeAuthToken),
    objectCount: Object.keys(status?.appState?.e2eeObjectMap || {}).length,
  });

  // Disconnect to restore clean state.
  await executeJs(ws, 'window.__testSync.disconnect()');

  console.log('[verify-sync] PASS');

  await send(ws, 'disconnect', {}).catch(() => {});
  ws.close();
}

main().catch((e) => {
  console.error('[verify-sync] ERROR:', e.stack || e.message || e);
  process.exit(1);
});
