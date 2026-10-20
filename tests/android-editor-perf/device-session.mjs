/**
 * The phone session: DevTools forwarding, the editor page over CDP, and the save and open-note steps.
 */

import { portsFor } from '../../scripts/lib/slot.mjs';
import { median, percentile95 } from '../lib/editorDevicePerf.mjs';
import { connectPage, saveExpression } from '../lib/editorDevicePerfSnippets.mjs';
import { NOTE_TITLE, PACKAGE, SAVE_SAMPLES } from './run-config.mjs';
import WebSocket from 'ws';

// ── CDP: the app's editor WebView ─────────────────────────────────

/** Forward the debug WebView's DevTools socket and return this run's port. */
export function forwardDevTools(adb) {
  const pid = adb.shell(`pidof ${PACKAGE}`, { allowFailure: true }).trim();
  if (!pid) throw new Error(`${PACKAGE} is not running`);
  const sockets = adb.shell('cat /proc/net/unix', { allowFailure: true });
  const socket = sockets.match(new RegExp(`webview_devtools_remote_${pid}\\b`))?.[0];
  if (!socket) {
    throw new Error(
      `no DevTools socket for pid ${pid} — the editor WebView has not been opened yet`,
    );
  }
  // Slot-derived like `just cdp-forward`, so parallel worktrees never steal
  // each other's forward; $CDP_PORT still wins.
  const port = Number(process.env.CDP_PORT || portsFor(process.cwd()).cdp);
  adb.adb(['forward', `tcp:${port}`, `localabstract:${socket}`]);
  return port;
}

/** One CDP session on the editor page (the shared client, tests/lib/editorDevicePerfSnippets.mjs). */
export async function connectEditorPage(port) {
  const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page at localhost:${port}`);
  return connectPage(page.webSocketDebuggerUrl, WebSocket);
}

// ── In-page measurement: tests/lib/editorDevicePerfSnippets.mjs (shared with the quick loop) ─

// ── Device stories ────────────────────────────────────────────────

export function requireSerial() {
  if (!process.env.ANDROID_SERIAL) {
    console.error(
      'Set $ANDROID_SERIAL to the claimed device (the low-end reference phone; `adb devices -l`).\n' +
        'Pool emulators come from: just qa-claim android',
    );
    process.exit(1);
  }
}

/**
 * Both save states (`saveSnippet`) on the fixture that is loaded. Warm first: it
 * waits on the editor's own priming after the open and the keystroke loop. A
 * failure is recorded, not thrown — evaluateSaveCost scores it.
 */
export async function measureSave(cdp, fixture, lines) {
  try {
    const { warmSamplesMs } = await cdp.evaluate(saveExpression(SAVE_SAMPLES));
    const { coldSamplesMs } = await cdp.evaluate(saveExpression(SAVE_SAMPLES, { cold: true }));
    return {
      fixture,
      lines,
      coldSamplesMs,
      warmSamplesMs,
      coldMedianMs: median(coldSamplesMs),
      coldP95Ms: percentile95(coldSamplesMs),
      warmMedianMs: median(warmSamplesMs),
      warmP95Ms: percentile95(warmSamplesMs),
    };
  } catch (error) {
    return { fixture, lines, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Tap the seeded note in the list; its label may carry a preview suffix. */
export async function openSeededNote(device) {
  const node = await device.waitFor(
    `the "${NOTE_TITLE}" note to appear in the list`,
    () =>
      device
        .uiNodes({ refresh: true })
        .find((n) => n.label === NOTE_TITLE || n.label.startsWith(`${NOTE_TITLE}\n`)) ?? null,
    { timeoutMs: 30_000 },
  );
  device.adb.tapPoint(node.x, node.y);
  device.invalidateUi();
}
