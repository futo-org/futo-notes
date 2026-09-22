#!/usr/bin/env node
/**
 * The FAST editor perf loop on the reference phone: the freshly built
 * editor.html, in the phone's own Chrome, measured over CDP — no APK build, no
 * install, no app relaunch. Build (5s) → serve → measure (seconds per fixture).
 *
 * Why Chrome and not the app: the Android System WebView and Chrome are the
 * same Chromium build on this device (151.0.7922.x on both, checked 2026-09-04),
 * so parse, layout, and V8 numbers carry over. What does NOT carry over is the
 * native chrome around the editor (Compose nested scroll, keyboard insets, the
 * host bridge), which is why `tests/android-editor-perf.mjs` remains the gate
 * and this is the iteration tool: tune here, confirm there.
 *
 * Both runners evaluate the SAME in-page snippet
 * (tests/lib/editorDevicePerfSnippets.mjs), so a number here means what a
 * number there means.
 *
 *   export ANDROID_SERIAL=<the phone>          # adb devices -l
 *   node tests/android-editor-perf-quick.mjs                          # 1000-lines-blocks, build first
 *   node tests/android-editor-perf-quick.mjs --fixture 10000-lines-blocks --no-build
 *   node tests/android-editor-perf-quick.mjs --profile                # where a keystroke's time goes
 *   node tests/android-editor-perf-quick.mjs --profile-open           # where the open's time goes
 *   node tests/android-editor-perf-quick.mjs --focused                # include native selection/layout work
 *
 * Fixture names: `<n>-lines-blocks` (real-note shaped, one block per line),
 * `<n>-lines` (no blank lines — fuses into a few huge blocks), or `real-note`
 * ($FUTO_PERF_NOTE / tests/editor-gauntlet/local/device-perf-note.md).
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { portsFor } from '../scripts/lib/slot.mjs';
import { createAdbClient } from './lib/android/adbClient.mjs';
import { DEVICE_BUDGET, blockFixture, lineFixture, percentile95 } from './lib/editorDevicePerf.mjs';
import {
  connectPage,
  keystrokeExpression,
  loadExpression,
  measureExpression,
  summarizeProfile,
} from './lib/editorDevicePerfSnippets.mjs';

const BUNDLE_DIR = path.resolve('build/native-editor');
const BUNDLE = path.join(BUNDLE_DIR, 'editor.html');
const CHROME = 'com.android.chrome';
const CHROME_MAIN = `${CHROME}/com.google.android.apps.chrome.Main`;
const LOCAL_NOTE_PATH = 'tests/editor-gauntlet/local/device-perf-note.md';

// ── Arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fixtures = [];
let build = true;
let samples = 25;
let profileKeystrokes = false;
let profileOpen = false;
let focused = false;
let top = 30;
let evalExpression = null;
let callers = null;
let shot = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--fixture') fixtures.push(args[++i]);
  else if (arg === '--eval') evalExpression = args[++i];
  else if (arg === '--eval-file') evalExpression = readFileSync(args[++i], 'utf8');
  else if (arg === '--callers') callers = args[++i];
  else if (arg === '--shot') shot = args[++i];
  else if (arg === '--no-build') build = false;
  else if (arg === '--samples') samples = Number(args[++i]);
  else if (arg === '--profile') profileKeystrokes = true;
  else if (arg === '--profile-open') profileOpen = true;
  else if (arg === '--focused') focused = true;
  else if (arg === '--top') top = Number(args[++i]);
  else {
    console.error(
      `Unrecognised argument: ${arg}\nSupported: --fixture <name> (repeatable), --no-build, --samples <n>, --profile, --profile-open, --focused, --top <n>, --callers <fn>, --eval <js>, --eval-file <path>, --shot <png>`,
    );
    process.exit(2);
  }
}
if (fixtures.length === 0) fixtures.push('1000-lines-blocks');
if (!process.env.ANDROID_SERIAL) {
  console.error('Set $ANDROID_SERIAL to the phone (`adb devices -l`).');
  process.exit(1);
}

function buildFixture(name) {
  let match = /^(\d+)-lines-blocks$/.exec(name);
  if (match) return blockFixture(Number(match[1]));
  match = /^(\d+)-lines$/.exec(name);
  if (match) return lineFixture(Number(match[1]));
  if (name === 'real-note') {
    const file = process.env.FUTO_PERF_NOTE || LOCAL_NOTE_PATH;
    if (!existsSync(file)) throw new Error(`no real note at ${file} (set $FUTO_PERF_NOTE)`);
    return readFileSync(file, 'utf8');
  }
  throw new Error(`unknown fixture "${name}"`);
}

// ── Build + serve ──────────────────────────────────────────────────

if (build) {
  process.stdout.write('building editor.html … ');
  const t0 = Date.now();
  execFileSync('node_modules/.bin/vite', ['build', '--config', 'vite.editor.config.ts'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
if (!existsSync(BUNDLE)) throw new Error(`${BUNDLE} is missing — run without --no-build`);

const ports = portsFor(process.cwd());
const webPort = Number(process.env.WEB_VITE_PORT || ports.web);
const cdpPort = Number(process.env.CDP_PORT || ports.cdp);

const server = createServer((req, res) => {
  // One file, whatever the path: editor.html is a single self-contained bundle.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(readFileSync(BUNDLE));
});
await new Promise((resolve) => server.listen(webPort, '127.0.0.1', resolve));

const adb = createAdbClient({ pkg: CHROME });
adb.adb(['reverse', `tcp:${webPort}`, `tcp:${webPort}`]);
adb.adb(['forward', `tcp:${cdpPort}`, 'localabstract:chrome_devtools_remote']);

const pageUrl = `http://localhost:${webPort}/editor.html`;

async function listTabs() {
  try {
    return await fetch(`http://localhost:${cdpPort}/json`).then((r) => r.json());
  } catch {
    return [];
  }
}

const ours = (tab) => tab.type === 'page' && tab.url.startsWith(`http://localhost:${webPort}/`);

async function waitFor(what, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let cdp = null;
let tabId = null;
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
  const navigationUrl = `${pageUrl}?t=${Date.now()}`;
  adb.shell(`am start -a android.intent.action.VIEW -d '${navigationUrl}' -n ${CHROME_MAIN}`);
  const tab = await waitFor(
    'the editor tab in Chrome',
    async () => (await listTabs()).find((tab) => tab.url === navigationUrl),
    20_000,
  );
  tabId = tab.id;
  cdp = await connectPage(tab.webSocketDebuggerUrl, WebSocket, {
    onEvent: (method, params) => {
      if (evalExpression && method === 'Runtime.consoleAPICalled') {
        const values = params.args.map((arg) => arg.value ?? arg.description);
        if (String(values[0]).startsWith('[perf-probe]')) console.log(...values);
      }
    },
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(
    'the editor to mount',
    () =>
      cdp
        .evaluate('Boolean(window.FutoEditor && window.__futoProseMirrorView?.())')
        .catch(() => false),
    30_000,
  );

  const model = adb.shell('getprop ro.product.model').trim();
  console.log(`Device: ${model} (${process.env.ANDROID_SERIAL}), Chrome tab ${tab.id}`);
  console.log(
    `Typing mode: ${focused ? 'focused (includes native selection/layout)' : 'default dispatch (does not request focus)'}`,
  );

  if (evalExpression) {
    /* An ad-hoc experiment against the mounted editor. `FIXTURE(name)` is
     * available so the expression can build the same documents the runners do. */
    const wrapped = `(async () => {
      const FIXTURES = ${JSON.stringify(Object.fromEntries(fixtures.map((n) => [n, buildFixture(n)])))};
      const FIXTURE = (name) => { if (!(name in FIXTURES)) throw new Error('pass --fixture ' + name); return FIXTURES[name]; };
      ${evalExpression}
    })()`;
    const result = await cdp.evaluate(wrapped);
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (shot) await screenshot(shot);
  }

  for (const name of evalExpression ? [] : fixtures) {
    const content = buildFixture(name);
    process.stdout.write(`  ${name} … `);

    if (profileOpen) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
      await cdp.evaluate(loadExpression(content));
      const { profile } = await cdp.send('Profiler.stop');
      const open = await cdp.evaluate(
        `performance.getEntriesByName('futo:editor-open-complete')[0]?.duration ?? null`,
      );
      console.log(`open ${Math.round(open)}ms — CPU profile of the open:`);
      printProfile(summarizeProfile(profile, { top, callers }));
      continue;
    }

    if (profileKeystrokes) {
      await cdp.evaluate(loadExpression(content));
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
      const typed = await cdp.evaluate(keystrokeExpression(samples, { focused }));
      const { profile } = await cdp.send('Profiler.stop');
      console.log(
        `keystroke p95 ${percentile95(typed.synchronousSamplesMs).toFixed(1)}ms ` +
          `(settled ${percentile95(typed.settledToPaintSamplesMs).toFixed(1)}ms) — CPU profile of ${samples} keystrokes:`,
      );
      printProfile(summarizeProfile(profile, { top, callers }));
      continue;
    }

    const measured = await cdp.evaluate(measureExpression(content, samples, { focused }));
    const syncP95 = percentile95(measured.synchronousSamplesMs);
    const settledP95 = percentile95(measured.settledToPaintSamplesMs);
    const openVerdict = measured.interactiveMs < DEVICE_BUDGET.interactiveMs ? 'ok' : 'OVER';
    const focusVerdict = measured.firstFocusMs < DEVICE_BUDGET.firstFocusMs ? 'ok' : 'OVER';
    const keyVerdict = syncP95 < DEVICE_BUDGET.keystrokeP95Ms ? 'ok' : 'OVER';
    if (!Number.isFinite(measured.interactiveMs) || !Number.isFinite(measured.completeMs)) {
      throw new Error(`${name}: missing open measurements`);
    }
    if (openVerdict === 'OVER' || focusVerdict === 'OVER' || keyVerdict === 'OVER') {
      process.exitCode = 1;
    }
    console.log(
      `interactive ${Math.round(measured.interactiveMs)}ms [${openVerdict} /${DEVICE_BUDGET.interactiveMs}], ` +
        `complete ${Math.round(measured.completeMs)}ms, ` +
        `first focus ${Math.round(measured.firstFocusMs)}ms [${focusVerdict} /${DEVICE_BUDGET.firstFocusMs}], ` +
        `keystroke p95 ${syncP95.toFixed(1)}ms [${keyVerdict} /${DEVICE_BUDGET.keystrokeP95Ms}] ` +
        `(settled ${settledP95.toFixed(1)}ms, median ${median(measured.synchronousSamplesMs).toFixed(1)}ms)`,
    );
    // The individual samples, so a p95 that is one cold first keystroke reads
    // differently from one that is a steady 16ms.
    console.log(
      `      sync ms: ${measured.synchronousSamplesMs.map((ms) => ms.toFixed(1)).join(' ')}\n` +
        `      settled ms: ${measured.settledToPaintSamplesMs.map((ms) => Math.round(ms)).join(' ')}`,
    );
  }
} finally {
  cdp?.close();
  if (tabId) await fetch(`http://localhost:${cdpPort}/json/close/${tabId}`);
  adb.adb(['forward', '--remove', `tcp:${cdpPort}`], { allowFailure: true });
  adb.adb(['reverse', '--remove', `tcp:${webPort}`], { allowFailure: true });
  server.close();
  server.closeAllConnections();
}

/** What the phone is showing right now (the Chrome tab, not the app). */
async function screenshot(file) {
  await new Promise((r) => setTimeout(r, 300));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`screenshot: ${file}`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function printProfile(summary) {
  console.log(`    sampled ${summary.totalMs.toFixed(0)}ms of CPU`);
  console.log('    by script:');
  for (const row of summary.urls.slice(0, 8)) {
    console.log(
      `      ${row.ms.toFixed(1).padStart(8)}ms ${(row.share * 100).toFixed(0).padStart(3)}%  ${row.label}`,
    );
  }
  console.log('    by function (self time):');
  for (const row of summary.frames) {
    console.log(
      `      ${row.ms.toFixed(1).padStart(8)}ms ${(row.share * 100).toFixed(0).padStart(3)}%  ${row.label}`,
    );
  }
  console.log('    by function (inclusive — callers own what they call):');
  for (const row of summary.inclusive) {
    console.log(
      `      ${row.ms.toFixed(1).padStart(8)}ms ${(row.share * 100).toFixed(0).padStart(3)}%  ${row.label}`,
    );
  }
  if (summary.callers) {
    console.log(
      `    callers of "${summary.callers.needle}" (inclusive time charged to the frame above it):`,
    );
    for (const row of summary.callers.rows) {
      console.log(
        `      ${row.ms.toFixed(1).padStart(8)}ms ${(row.share * 100).toFixed(0).padStart(3)}%  ${row.label}`,
      );
    }
  }
}
