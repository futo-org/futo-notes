#!/usr/bin/env node
/**
 * How long leaving a note takes on Android, phase by phase, in the REAL
 * debug app on $ANDROID_SERIAL — the numbers behind
 * docs/perf/mobile-close-baseline.md.
 *
 *   export ANDROID_SERIAL=<emulator or phone>   # adb devices -l
 *   node scripts/perf/android-close-probe.mjs [--samples 5] [--label before]
 *       [--scenarios clean-1k,dirty-1k,dirty-10k,arrow-1k,ime-1k] [--out <json>]
 *
 * The app's debug build logs a `FutoClose` line per exit phase
 * (apps/android/.../ui/CloseLedger.kt): `begin` at the Back press, then each
 * phase at its offset in ms, ending with `listFrame` — the first frame the
 * note list draws after the pop. This script seeds two fixture notes into the
 * DEV app's vault (com.futo.notes.dev; removed afterwards), opens one from the
 * list like a finger does, optionally makes it dirty by typing through the
 * editor WebView over CDP, presses Back, and reads the ledger off logcat.
 *
 * Scenarios:
 *   clean-<n>   open, let it settle, system Back
 *   dirty-<n>   type for 150 ms (one insert every 40 ms), stop, and press
 *               system Back at once, so the editor still holds an unreported
 *               edit and the exit's flush round trip is real
 *   arrow-<n>   open, let it settle, the top-bar Back arrow with the keyboard
 *               down — the control for ime-<n>
 *   ime-<n>     tap into the body so the soft keyboard is up, then the top-bar
 *               Back arrow — the one exit that leaves with the keyboard shown
 *               (system Back would dismiss the keyboard first)
 *
 * Samples of every scenario are interleaved (round-robin), so a drift in the
 * machine's load lands on all of them alike.
 *
 * Safety: never wipes the app — no `pm clear`, no uninstall; it removes only
 * the two notes it wrote (tests/lib/android-native-instance.mjs has the rule).
 */

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

import { portsFor } from '../lib/slot.mjs';
import { createAndroidDevice } from '../../tests/lib/android/device.mjs';
import { quoteForDeviceShell } from '../../tests/lib/android/adbClient.mjs';
import { blockFixture, median } from '../../tests/lib/editorDevicePerf.mjs';
import { connectPage } from '../../tests/lib/editorDevicePerfSnippets.mjs';

const PACKAGE = 'com.futo.notes.dev';
const LEDGER_TAG = 'FutoClose';
const TITLE = (n) => `Close probe ${n}`;
const FIXTURES = { '1k': 1000, '10k': 10000 };

// ── Arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
let samples = 5;
let label = 'run';
let scenarios = ['clean-1k', 'dirty-1k', 'dirty-10k', 'arrow-1k', 'ime-1k'];
let out = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--samples') samples = Number(args[++i]);
  else if (arg === '--label') label = args[++i];
  else if (arg === '--scenarios') scenarios = args[++i].split(',');
  else if (arg === '--out') out = args[++i];
  else {
    console.error(`Unrecognised argument: ${arg}`);
    process.exit(2);
  }
}
if (!process.env.ANDROID_SERIAL) {
  console.error('Set $ANDROID_SERIAL (`adb devices -l`).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// ── CDP on the editor WebView (same shape as tests/android-editor-perf.mjs) ──

function forwardDevTools(adb) {
  const pid = adb.shell(`pidof ${PACKAGE}`, { allowFailure: true }).trim();
  if (!pid) throw new Error(`${PACKAGE} is not running`);
  const sockets = adb.shell('cat /proc/net/unix', { allowFailure: true });
  const socket = sockets.match(new RegExp(`webview_devtools_remote_${pid}\\b`))?.[0];
  if (!socket) throw new Error('no DevTools socket yet');
  const port = Number(process.env.CDP_PORT || portsFor(process.cwd()).cdp);
  adb.adb(['forward', `tcp:${port}`, `localabstract:${socket}`]);
  return port;
}

async function connectEditorPage(port) {
  const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page at localhost:${port}`);
  return connectPage(page.webSocketDebuggerUrl, WebSocket);
}

/**
 * The ledger lines of ONE exit, as {phase: ms}, or null until the exit has both
 * reached the list (`listFrame`) and finished committing (`titleCommitted`, the
 * last commit step, or `exitFailed`). Which of the two comes first is the
 * thing being measured, so the probe waits for both.
 */
function readLedger(adb) {
  const lines = adb.readLogcat(`${LEDGER_TAG}:I`, '*:S').split('\n');
  const begin = lines
    .map((l, i) => (/ begin /.test(l) ? i : -1))
    .filter((i) => i >= 0)
    .pop();
  if (begin === undefined) return null;
  const phases = {};
  for (const line of lines.slice(begin + 1)) {
    const m = line.match(/FutoClose\s*: (\w+) ([\d.]+)/);
    if (m) phases[m[1]] = Number(m[2]);
  }
  const settled = 'titleCommitted' in phases || 'exitFailed' in phases;
  return 'listFrame' in phases && settled ? phases : null;
}

/** The app's HWUI frame stats since the last reset, as ledger fields. */
function readFrames(adb) {
  const out = adb.shell(`dumpsys gfxinfo ${PACKAGE}`, { allowFailure: true });
  const num = (re) => Number(out.match(re)?.[1] ?? NaN);
  return {
    frames: num(/Total frames rendered: (\d+)/),
    jankyFrames: num(/Janky frames: (\d+)/),
    frameP90: num(/90th percentile: (\d+)ms/),
    frameP99: num(/99th percentile: (\d+)ms/),
  };
}

async function main() {
  const device = createAndroidDevice({ pkg: PACKAGE });
  const { adb } = device;
  device.requireReady();
  console.log(
    `Device: ${adb.shell('getprop ro.product.model').trim()} (${adb.serial}, Android ${adb.shell('getprop ro.build.version.release').trim()})`,
  );
  console.log(`Host load at start: ${readFileSync('/proc/loadavg', 'utf8').trim()}`);

  adb.shell('input keyevent KEYCODE_WAKEUP');
  adb.shell('wm dismiss-keyguard', { allowFailure: true });
  device.relaunch();
  const state = await device.waitForState('the note shell', (s) => s.shellVisible || s.onboarding, {
    timeoutMs: 60_000,
  });
  if (state.onboarding) {
    await device.tap('App storage');
    await device.tap('Continue');
    await device.waitForState('the shell after onboarding', (s) => s.shellVisible, {
      timeoutMs: 60_000,
    });
  }
  const vaultPath = (await device.state()).vaultPath;
  if (!vaultPath) throw new Error('the app reported no vaultPath');

  const notePaths = [];
  for (const [key, lines] of Object.entries(FIXTURES)) {
    const path = `${vaultPath}/${TITLE(key)}.md`;
    adb.writeFile(path, `# ${TITLE(key)}\n\n${blockFixture(lines)}`);
    notePaths.push(path);
  }
  device.relaunch();
  await device.waitForState('the note list', (s) => s.shellVisible, { timeoutMs: 60_000 });

  let cdp = null;
  let forwardedPort = null;
  const results = Object.fromEntries(scenarios.map((s) => [s, []]));

  async function openNote(key) {
    const title = TITLE(key);
    const node = await device.waitFor(
      `the "${title}" note in the list`,
      () =>
        device
          .uiNodes({ refresh: true })
          .find((n) => n.label === title || n.label.startsWith(`${title}\n`)) ?? null,
      { timeoutMs: 30_000 },
    );
    adb.tapPoint(node.x, node.y);
    device.invalidateUi();
    if (!cdp) {
      forwardedPort = await device.waitFor(
        'the editor WebView DevTools socket',
        () => {
          try {
            return forwardDevTools(adb);
          } catch {
            return null;
          }
        },
        { timeoutMs: 30_000 },
      );
      cdp = await connectEditorPage(forwardedPort);
    }
    await device.waitFor(
      `the editor to hold "${title}"`,
      async () =>
        cdp.evaluate(
          `Boolean(window.FutoEditor && window.__futoProseMirrorView?.()) &&
           performance.getEntriesByName('futo:editor-open-complete').length > 0 &&
           window.__futoTest.readDocument().includes(${JSON.stringify(title)})`,
        ),
      { timeoutMs: 60_000 },
    );
    // Let the open's own change report and autosave settle, so a clean exit
    // is genuinely clean (the 200 ms change debounce + the 400 ms save).
    await sleep(1500);
  }

  async function awaitLedger() {
    return device.waitFor('the exit to reach the list', () => readLedger(adb), {
      timeoutMs: 20_000,
      pollIntervalMs: 50,
    });
  }

  async function runScenario(scenario) {
    const [kind, key] = scenario.split('-');
    await openNote(key);
    adb.shell('logcat -c', { allowFailure: true });
    // Frame stats cover the whole exit, not just the list's first frame: a
    // relayout of the leaving editor lands on the frames after it.
    const resetFrames = () => adb.shell(`dumpsys gfxinfo ${PACKAGE} reset`, { allowFailure: true });
    if (kind !== 'ime') resetFrames();
    if (kind === 'clean') {
      adb.keyevent(4);
    } else if (kind === 'arrow') {
      await device.tap('Back', { scroll: false });
    } else if (kind === 'dirty') {
      // Type a short burst, stop as Back is sent (a finger cannot type after
      // pressing Back), and land Back inside the 200 ms change debounce: the
      // exit then holds an unreported edit and its flush round trip is real.
      await cdp.evaluate(`(() => {
        window.__closeProbeStop = false;
        const view = window.__futoProseMirrorView();
        const type = () => {
          if (window.__closeProbeStop) return;
          view.dispatch(view.state.tr.insertText('x'));
          setTimeout(type, 40);
        };
        type();
        return true;
      })()`);
      await sleep(150);
      await cdp.evaluate('window.__closeProbeStop = true');
      adb.keyevent(4);
    } else if (kind === 'ime') {
      // A real tap into the body raises the soft keyboard; CDP focus does not.
      const size = adb.shell('wm size').match(/(\d+)x(\d+)/);
      adb.tapPoint(Math.round(Number(size[1]) / 2), Math.round(Number(size[2]) * 0.6));
      await device.waitFor(
        'the soft keyboard to show',
        () => /mInputShown=true/.test(adb.shell('dumpsys input_method', { allowFailure: true })),
        { timeoutMs: 10_000 },
      );
      await sleep(400);
      adb.shell('logcat -c', { allowFailure: true });
      resetFrames();
      await device.tap('Back', { scroll: false });
    } else {
      throw new Error(`unknown scenario ${scenario}`);
    }
    const ledger = await awaitLedger();
    // The exit animation runs 220 ms (FutoMotion.Base); read once it is over.
    await sleep(600);
    Object.assign(ledger, readFrames(adb));
    results[scenario].push(ledger);
    const phases = Object.entries(ledger)
      .map(([p, ms]) => `${p} ${ms.toFixed(0)}`)
      .join(', ');
    console.log(`  ${scenario}: ${phases}`);
    // Let any background commit land before the next open.
    await sleep(2000);
    await device.waitForState('the note list', (s) => s.shellVisible, { timeoutMs: 30_000 });
  }

  try {
    for (let i = 0; i < samples; i += 1) {
      for (const scenario of scenarios) await runScenario(scenario);
    }
  } finally {
    cdp?.close();
    if (forwardedPort) adb.adb(['forward', '--remove', `tcp:${forwardedPort}`]);
    adb.forceStop();
    for (const p of notePaths) adb.shell(`rm -f ${quoteForDeviceShell(p)}`, { allowFailure: true });
  }

  console.log(`\nHost load at end: ${readFileSync('/proc/loadavg', 'utf8').trim()}`);
  console.log(`\n${label}: median / p90 ms from the Back press (n=${samples})`);
  const phaseOrder = [
    'prepared',
    'navigate',
    'bodyCurrent',
    'bodyCommitted',
    'titleCommitted',
    'listFrame',
    'exitFailed',
    'frames',
    'jankyFrames',
    'frameP90',
    'frameP99',
  ];
  const summary = {};
  for (const scenario of scenarios) {
    const rows = results[scenario];
    summary[scenario] = {};
    const cells = phaseOrder
      .filter((p) => rows.some((r) => p in r))
      .map((p) => {
        const values = rows.filter((r) => p in r).map((r) => r[p]);
        summary[scenario][p] = { median: median(values), p90: percentile(values, 90), values };
        return `${p} ${median(values).toFixed(0)}/${percentile(values, 90).toFixed(0)}`;
      });
    console.log(`  ${scenario}: ${cells.join('  ')}`);
  }
  if (out) {
    writeFileSync(
      out,
      JSON.stringify({ label, samples, device: adb.serial, summary, results }, null, 2),
    );
    console.log(`wrote ${out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
