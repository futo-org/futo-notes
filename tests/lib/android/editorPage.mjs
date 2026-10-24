/**
 * A CDP session on the editor WebView of the REAL dev app, with a seeded note
 * open — the plumbing every real-app editor measurement starts with
 * (`tests/android-editor-perf.mjs`, the block-drag bench's app mode,
 * `tests/android-editor-attribution.mjs`).
 *
 * The note is seeded into the DEV app's own vault (com.futo.notes.dev, never
 * the release package) and removed on close; keystrokes autosave into it.
 * Nothing here wipes the app (no `pm clear`, no uninstall).
 */
import WebSocket from 'ws';

import { portsFor } from '../../../scripts/lib/slot.mjs';
import { quoteForDeviceShell } from './adbClient.mjs';
import { connectPage } from '../editorDevicePerfSnippets.mjs';

export const DEV_PACKAGE = 'com.futo.notes.dev';

/**
 * Relaunches the app, seeds `noteTitle`, opens it, and connects to the editor
 * page. `onEvent` receives every CDP event (`Debugger.scriptParsed`, …).
 *
 * @returns `{ cdp, port, close }`; `close` drops the forward, stops the app and removes the note
 */
export async function openEditorPage(device, { root, noteTitle, onEvent, pkg = DEV_PACKAGE }) {
  const { adb } = device;
  // rAF needs frames: wake the screen and dismiss the keyguard, or every
  // settled sample stalls silently (M21).
  adb.shell('input keyevent KEYCODE_WAKEUP');
  adb.shell('wm dismiss-keyguard', { allowFailure: true });
  device.relaunch();
  const state = await device.waitForState('the note shell', (s) => s.shellVisible || s.onboarding, {
    timeoutMs: 60_000,
  });
  if (state.onboarding) {
    // First run on a fresh emulator: app storage keeps the run inside the
    // app's own sandbox.
    await device.tap('App storage');
    await device.tap('Continue');
    await device.waitForState('the shell after onboarding', (s) => s.shellVisible, {
      timeoutMs: 60_000,
    });
  }
  const vaultPath = (await device.state()).vaultPath;
  if (!vaultPath) throw new Error('the app reported no vaultPath');
  const notePath = `${vaultPath}/${noteTitle}.md`;
  adb.writeFile(notePath, `# ${noteTitle}\n`);
  device.relaunch();
  await device.waitForState('the note list', (s) => s.shellVisible, { timeoutMs: 60_000 });
  // A ready engine can hold a root note outside LazyColumn's viewport under
  // the persisted sort. The label driver scrolls and resolves one safe tap.
  const visibleRow = device
    .uiNodes({ refresh: true })
    .find((n) => n.label === noteTitle || n.label.startsWith(`${noteTitle}\n`));
  await device.tap(visibleRow?.label ?? noteTitle, { timeoutMs: 30_000 });

  // Slot-derived like `just cdp-forward`, so parallel worktrees never steal
  // each other's forward; $CDP_PORT still wins.
  const port = Number(process.env.CDP_PORT || portsFor(root).cdp);
  const socket = await device.waitFor(
    'the editor WebView DevTools socket',
    () => {
      const pid = adb.shell(`pidof ${pkg}`, { allowFailure: true }).trim();
      const unix = adb.shell('cat /proc/net/unix', { allowFailure: true });
      return (pid && unix.match(new RegExp(`webview_devtools_remote_${pid}\\b`))?.[0]) || null;
    },
    { timeoutMs: 30_000 },
  );
  adb.adb(['forward', `tcp:${port}`, `localabstract:${socket}`]);
  const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page at localhost:${port}`);
  const cdp = await connectPage(page.webSocketDebuggerUrl, WebSocket, { onEvent });
  await device.waitFor(
    "the host's own load of the seeded note",
    () =>
      cdp.evaluate(
        `Boolean(window.FutoEditor && window.__futoProseMirrorView?.()) &&
           Boolean(window.__futoTest?.readDocument()?.includes(${JSON.stringify(noteTitle)}))`,
      ),
    { timeoutMs: 30_000 },
  );
  const close = () => {
    cdp.close();
    adb.adb(['forward', '--remove', `tcp:${port}`], { allowFailure: true });
    adb.forceStop();
    adb.shell(`rm -f ${quoteForDeviceShell(notePath)}`, { allowFailure: true });
  };
  return { cdp, port, close };
}
