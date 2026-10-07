/*
 * `block-drag-bench.mjs --device android-app`: the block drag in the REAL
 * native Android app on $ANDROID_SERIAL — the gate the phone-Chrome loop
 * (`--device android`) only predicts.
 *
 * Per variant it builds editor.html with that blockDragSession.ts (the same
 * bundle the app ships, staged into its assets) and installs the debug app.
 * Then, inside the app's own editor WebView over CDP, it loads the benchmark
 * note and performs the real gesture with touch input: the long press
 * (mobileBlockDnd.ts), the finger alternating between two gaps, the finger
 * parked in the bottom auto-scroll zone, and the release. A requestAnimationFrame
 * recorder in the page times every frame; each phase reports the frames that
 * fell inside it. Nothing here calls the session directly — what is timed is
 * what a finger gets.
 *
 * The note is seeded into the DEV app's own vault (com.futo.notes.dev; never
 * the release package) and removed afterwards; drops autosave into it.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import WebSocket from 'ws';

import { portsFor } from '../../lib/slot.mjs';
import { createAndroidDevice } from '../../../tests/lib/android/device.mjs';
import { quoteForDeviceShell } from '../../../tests/lib/android/adbClient.mjs';
import { connectPage, loadExpression } from '../../../tests/lib/editorDevicePerfSnippets.mjs';
import { generateNote } from './note.mjs';

const PACKAGE = 'com.futo.notes.dev';
const NOTE_TITLE = 'Block drag bench';
/** Gap-change moves per run, one every GAP_MOVE_MS. */
const GAP_MOVES = 30;
const GAP_MOVE_MS = 12;
/** How long the finger rests in the auto-scroll zone. */
const SCROLL_HOLD_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds editor.html with `variant` and installs the debug app with it. */
export async function installVariant(variant, { root, sessionVariantPlugin }) {
  const { build, loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(root, 'vite.editor.config.ts'),
  );
  // The config's own staging plugin copies the bundle into the app's assets.
  await build({
    ...loaded.config,
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [sessionVariantPlugin(variant), ...loaded.config.plugins],
  });
  const gradle = path.join(root, 'apps/android/gradlew');
  execFileSync(gradle, [':app:installDirectDebug', '-q'], {
    cwd: path.join(root, 'apps/android'),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** Opens the seeded note in the app and returns a CDP session on its editor. */
async function openApp(device, root) {
  const { adb } = device;
  adb.shell('input keyevent KEYCODE_WAKEUP');
  adb.shell('wm dismiss-keyguard', { allowFailure: true });
  device.relaunch();
  const state = await device.waitForState('the note shell', (s) => s.shellVisible || s.onboarding, {
    timeoutMs: 60_000,
  });
  if (state.onboarding) throw new Error('the dev app is at onboarding; set it up once by hand');
  const vaultPath = (await device.state()).vaultPath;
  if (!vaultPath) throw new Error('the app reported no vaultPath');
  const notePath = `${vaultPath}/${NOTE_TITLE}.md`;
  adb.writeFile(notePath, `# ${NOTE_TITLE}\n`);
  device.relaunch();
  await device.waitForState('the note list', (s) => s.shellVisible, { timeoutMs: 60_000 });
  const row = await device.waitFor(
    `the "${NOTE_TITLE}" row`,
    () =>
      device
        .uiNodes({ refresh: true })
        .find((n) => n.label === NOTE_TITLE || n.label.startsWith(`${NOTE_TITLE}\n`)) ?? null,
    { timeoutMs: 30_000 },
  );
  adb.tapPoint(row.x, row.y);
  device.invalidateUi();

  const port = Number(process.env.CDP_PORT || portsFor(root).cdp);
  const socket = await device.waitFor(
    'the editor WebView DevTools socket',
    () => {
      const pid = adb.shell(`pidof ${PACKAGE}`, { allowFailure: true }).trim();
      const unix = adb.shell('cat /proc/net/unix', { allowFailure: true });
      return (pid && unix.match(new RegExp(`webview_devtools_remote_${pid}\\b`))?.[0]) || null;
    },
    { timeoutMs: 30_000 },
  );
  adb.adb(['forward', `tcp:${port}`, `localabstract:${socket}`]);
  const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page at localhost:${port}`);
  const cdp = await connectPage(page.webSocketDebuggerUrl, WebSocket, {
    onEvent: (method, params) => cdp.onEvent?.(method, params),
  });
  await device.waitFor(
    "the host's own load of the seeded note",
    () =>
      cdp.evaluate(
        `Boolean(window.FutoEditor && window.__futoProseMirrorView?.()) &&
           Boolean(window.__futoTest?.readDocument()?.includes(${JSON.stringify(NOTE_TITLE)}))`,
      ),
    { timeoutMs: 30_000 },
  );
  const close = () => {
    cdp.close();
    adb.adb(['forward', '--remove', `tcp:${port}`], { allowFailure: true });
    adb.forceStop();
    adb.shell(`rm -f ${quoteForDeviceShell(notePath)}`, { allowFailure: true });
  };
  return { cdp, close };
}

/** In-page: every frame's timestamp, from now until stopped. */
const RECORD = `(() => {
  window.__bdFrames = [];
  window.__bdRecording = true;
  const loop = (t) => { if (!window.__bdRecording) return; window.__bdFrames.push(performance.now()); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return performance.now();
})()`;

/** The frame intervals that ENDED inside [from, to] (page clock). */
function framesBetween(frames, from, to) {
  const out = [];
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i] > from && frames[i] <= to) out.push(frames[i] - frames[i - 1]);
  }
  return out;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

async function runOnce(cdp, blocks) {
  await cdp.evaluate(loadExpression(generateNote(blocks)));
  const geo = await cdp.evaluate(`(async () => {
    const v = window.__futoProseMirrorView();
    v.dom.scrollTop = 0;
    for (let i = 0; i < 10; i += 1) await new Promise((r) => requestAnimationFrame(r));
    if (v.state.doc.childCount !== ${blocks}) throw new Error('expected ${blocks} blocks, have ' + v.state.doc.childCount);
    const r = v.dom.getBoundingClientRect();
    const first = v.dom.children[0].getBoundingClientRect();
    const bottom = Math.min(r.bottom, innerHeight);
    const top = Math.max(r.top, 0);
    return { x: Math.round(r.left + r.width / 2), liftY: Math.round(first.top + first.height / 2),
      yA: Math.round(top + (bottom - top) * 0.45), yB: Math.round(top + (bottom - top) * 0.85),
      edgeY: Math.round(bottom - 12) };
  })()`);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });

  // Let the load's own aftermath (the host's debounced save serializes the
  // whole note on the main thread) finish first: wait for 600ms of frames all
  // under 25ms. Its idle frame interval is the app's vsync.
  const vsyncMs = await cdp.evaluate(`(async () => {
    const deadline = performance.now() + 20000;
    let quietSince = performance.now();
    const intervals = [];
    let last = await new Promise((r) => requestAnimationFrame(r));
    while (performance.now() - quietSince < 600) {
      if (performance.now() > deadline) throw new Error('the page never went quiet after the load');
      const t = await new Promise((r) => requestAnimationFrame(r));
      if (t - last > 25) quietSince = t;
      intervals.push(t - last);
      last = t;
    }
    intervals.sort((a, b) => a - b);
    return intervals[Math.floor(intervals.length / 2)];
  })()`);
  await cdp.evaluate(RECORD);
  await sleep(200);
  // BD_TRACE_LIFT=<file.json>: a Chromium trace of the first lift.
  let trace = null;
  if (process.env.BD_TRACE_LIFT && !runOnce.traced) {
    runOnce.traced = true;
    const events = [];
    let complete;
    trace = { events, done: new Promise((r) => (complete = r)) };
    cdp.onEvent = (method, params) => {
      if (method === 'Tracing.dataCollected') events.push(...params.value);
      if (method === 'Tracing.tracingComplete') complete();
    };
    await cdp.send('Tracing.start', {
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        includedCategories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'blink',
          'cc',
          'toplevel',
          'v8.execute',
          'disabled-by-default-devtools.timeline.invalidationTracking',
        ],
      },
      transferMode: 'ReportEvents',
    });
  }
  const t0 = await cdp.evaluate('performance.now()');
  await touch('touchStart', geo.x, geo.liftY);
  const lifted = await cdp.evaluate(`(async () => {
    for (let i = 0; i < 300; i += 1) {
      if (document.querySelector('.futo-mobile-dnd-ghost')) return performance.now();
      await new Promise((r) => requestAnimationFrame(r));
    }
    throw new Error('the long press never lifted the block');
  })()`);
  await sleep(500);
  if (trace) {
    await cdp.send('Tracing.end');
    await trace.done;
    (await import('node:fs')).writeFileSync(
      process.env.BD_TRACE_LIFT,
      JSON.stringify({ traceEvents: trace.events }),
    );
    console.error(`lift trace: ${process.env.BD_TRACE_LIFT}`);
  }
  const g0 = await cdp.evaluate('performance.now()');
  for (let i = 0; i < GAP_MOVES; i += 1) {
    await touch('touchMove', geo.x + (i % 2), i % 2 ? geo.yA : geo.yB);
    await sleep(GAP_MOVE_MS);
  }
  const g1 = await cdp.evaluate('performance.now()');
  const mode = await cdp.evaluate(
    `document.querySelector('.futo-mobile-dnd-indicator--visible') ? 'line' : 'reflow'`,
  );
  await touch('touchMove', geo.x, geo.edgeY);
  await sleep(150);
  const s0 = await cdp.evaluate(
    '[performance.now(), window.__futoProseMirrorView().dom.scrollTop]',
  );
  await sleep(SCROLL_HOLD_MS);
  const s1 = await cdp.evaluate(
    '[performance.now(), window.__futoProseMirrorView().dom.scrollTop]',
  );
  await touch('touchMove', geo.x, geo.yB);
  await sleep(300);
  const d0 = await cdp.evaluate('performance.now()');
  await touch('touchEnd');
  // Long enough for the slowest release seen (the end of the press restyles
  // the whole note: ~2.7s on 3,000 blocks on the reference phone).
  await sleep(4000);
  const end = await cdp.evaluate(`(() => {
    window.__bdRecording = false;
    const v = window.__futoProseMirrorView();
    const leftover = document.querySelectorAll('.futo-mobile-dnd-ghost, .futo-mobile-dnd-reflow-clip').length +
      Array.from(v.dom.children).filter((el) => el.style.transform).length;
    return { now: performance.now(), frames: window.__bdFrames, leftover };
  })()`);
  const { frames } = end;
  // The lift: the longest frame from just before the long-press timer fires
  // (340ms) to 300ms after the lift was seen — the frame that carried it.
  const liftFrames = framesBetween(frames, t0 + 300, lifted + 300);
  const gapFrames = framesBetween(frames, g0, g1);
  const scrollFrames = framesBetween(frames, s0[0], s1[0]);
  // The release: every frame that ENDED within 4s of it — a release whose one
  // frame takes seconds must not fall outside a short window and vanish.
  const dropFrames = framesBetween(frames, d0, d0 + 3900);
  const one = (ms) => ({ reps: 1, totalMs: ms, samplesMs: [ms] });
  const many = (xs) => ({ reps: xs.length, totalMs: sum(xs), samplesMs: xs });
  return {
    blocks,
    mode,
    leftover: end.leftover,
    scroller: `vsync ${vsyncMs.toFixed(1)}ms, auto-scrolled ${Math.round(s1[1] - s0[1])}px`,
    result: {
      'lift frame': one(Math.max(...liftFrames)),
      'gap frame': many(gapFrames),
      'scroll frame': many(scrollFrames),
      'drop frame': one(Math.max(...dropFrames)),
    },
  };
}

/** Runs the plan in the installed app; returns the runs, report-shaped. */
export async function runInApp(opts, { root }) {
  const device = createAndroidDevice({ pkg: PACKAGE });
  device.requireReady();
  const { cdp, close } = await openApp(device, root);
  try {
    const runs = [];
    for (let r = 0; r < opts.repeat; r += 1) {
      for (const size of opts.sizes) runs.push(await runOnce(cdp, size));
    }
    return runs;
  } finally {
    close();
  }
}
