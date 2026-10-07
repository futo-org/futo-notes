/**
 * One page, served from this machine, open in the phone's own Chrome and
 * driven over CDP — the fast perf loop's transport. Chrome and the Android
 * System WebView are the same Chromium build on the reference phone, so what a
 * page costs here is what it costs in the app's WebView, minus the native
 * chrome around it.
 *
 * Needs $ANDROID_SERIAL. Serves exactly one file (whatever path is asked for),
 * which is all a single-file editor.html bundle needs.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import WebSocket from 'ws';

import { portsFor } from '../../../scripts/lib/slot.mjs';
import { createAdbClient } from './adbClient.mjs';
import { connectPage } from '../editorDevicePerfSnippets.mjs';

const CHROME = 'com.android.chrome';
const CHROME_MAIN = `${CHROME}/com.google.android.apps.chrome.Main`;

async function waitFor(what, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Serves `file`, opens it in the phone's Chrome at `?<query>&t=<now>`, and
 * returns the connected page plus `close()`, which closes the tab and removes
 * every forward this opened. `ready` is a page expression polled until truthy.
 */
export async function openInPhoneChrome({ file, query = '', ready, onEvent, cwd = process.cwd() }) {
  if (!process.env.ANDROID_SERIAL)
    throw new Error('Set $ANDROID_SERIAL to the phone (`adb devices -l`).');
  const ports = portsFor(cwd);
  const webPort = Number(process.env.WEB_VITE_PORT || ports.web);
  const cdpPort = Number(process.env.CDP_PORT || ports.cdp);

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(webPort, '127.0.0.1', resolve));

  const adb = createAdbClient({ pkg: CHROME });
  adb.adb(['reverse', `tcp:${webPort}`, `tcp:${webPort}`]);
  adb.adb(['forward', `tcp:${cdpPort}`, 'localabstract:chrome_devtools_remote']);

  const listTabs = async () => {
    try {
      return await fetch(`http://localhost:${cdpPort}/json`).then((r) => r.json());
    } catch {
      return [];
    }
  };
  const ours = (tab) => tab.type === 'page' && tab.url.startsWith(`http://localhost:${webPort}/`);

  let cdp = null;
  let tabId = null;
  const close = async () => {
    cdp?.close();
    if (tabId) await fetch(`http://localhost:${cdpPort}/json/close/${tabId}`).catch(() => {});
    adb.adb(['forward', '--remove', `tcp:${cdpPort}`], { allowFailure: true });
    adb.adb(['reverse', '--remove', `tcp:${webPort}`], { allowFailure: true });
    server.close();
    server.closeAllConnections();
  };

  try {
    // rAF needs frames: wake the screen, drop the keyguard, foreground Chrome.
    adb.shell('input keyevent KEYCODE_WAKEUP');
    adb.shell('wm dismiss-keyguard', { allowFailure: true });
    adb.shell(`am start -n ${CHROME_MAIN}`, { allowFailure: true });

    // A previous probe may have left its renderer stuck in layout. Closing our
    // own test tab works even when Page.navigate cannot interrupt that renderer.
    for (const old of (await listTabs()).filter(ours)) {
      await fetch(`http://localhost:${cdpPort}/json/close/${old.id}`);
    }
    const url = `http://localhost:${webPort}/editor.html?${query ? `${query}&` : ''}t=${Date.now()}`;
    adb.shell(`am start -a android.intent.action.VIEW -d '${url}' -n ${CHROME_MAIN}`);
    const tab = await waitFor(
      'the page tab in Chrome',
      async () => (await listTabs()).find((t) => t.url === url),
      20_000,
    );
    tabId = tab.id;
    cdp = await connectPage(tab.webSocketDebuggerUrl, WebSocket, { onEvent });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    if (ready)
      await waitFor('the page to be ready', () => cdp.evaluate(ready).catch(() => false), 30_000);
    return { cdp, adb, tabId, close };
  } catch (error) {
    await close();
    throw error;
  }
}
