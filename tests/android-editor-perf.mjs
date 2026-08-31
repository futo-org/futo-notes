#!/usr/bin/env node
/**
 * Editor performance stories against the REAL native Android app on an
 * explicitly claimed device — the low-end reference phone (issue #106,
 * docs/plan/milkdown-transition.md §5 / D7).
 *
 * What it enforces, on the device it is hardest on:
 *
 * - time-to-interactive-first-viewport under 1s at real-note sizes (the
 *   `futo:editor-open-interactive` performance measure the editor itself
 *   records — the same entry Playwright and DevTools read on desktop),
 * - synchronous keystroke p95 under 16ms at EVERY size (AGENTS.md M5),
 * - "scales linearly, no cliff" above real-note sizes (50k lines vs 10k),
 * - the content-visibility containment stylesheet working inside the real
 *   editor chrome: computed style active, caret reachable into offscreen
 *   (rendering-skipped) regions, scroll behavior intact.
 *
 * The budgets and policies live in tests/lib/editorDevicePerf.mjs (unit
 * tested); this file is the device glue. Measurements run INSIDE the app's
 * editor WebView over CDP — `Runtime.evaluate` against the same
 * `window.FutoEditor` / `__futoProseMirrorView` seams the desktop gauntlet
 * drives, so device and desktop numbers time the same unit.
 *
 * The maintainer's largest real note joins the fixtures as a LOCAL,
 * UNCOMMITTED file (acceptance criterion): pass its path as $FUTO_PERF_NOTE,
 * or drop it at tests/editor-gauntlet/local/device-perf-note.md (a gitignored
 * directory). Without one the run still enforces the synthetic ladder and
 * says loudly that the real-note fixture was absent.
 *
 * Usage:
 *   export ANDROID_SERIAL=<the claimed phone>   # adb devices -l
 *   just test-android-perf                      # builds + installs first
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { portsFor } from '../scripts/lib/slot.mjs';
import { createAndroidDevice } from './lib/android/device.mjs';
import { quoteForDeviceShell } from './lib/android/adbClient.mjs';
import {
  DEVICE_BUDGET,
  blockFixture,
  evaluateDeviceFloor,
  lineFixture,
  percentile95,
} from './lib/editorDevicePerf.mjs';

/**
 * Flags, parsed once and strictly: an unrecognised argument fails the run
 * rather than being ignored, so `--stres` cannot look like a 50k run that
 * quietly measured 25k instead.
 */
const FLAGS = new Set(['--stress', '--containment-only']);
const unknownArgs = process.argv.slice(2).filter((arg) => !FLAGS.has(arg));
if (unknownArgs.length > 0) {
  console.error(
    `Unrecognised argument(s): ${unknownArgs.join(' ')}\nSupported: ${[...FLAGS].join(', ')}`,
  );
  process.exit(2);
}
const STRESS = process.argv.includes('--stress');
/**
 * Run ONLY the containment leg. The fixture ladder costs ~20 minutes on the
 * reference phone, which is too slow to iterate on the containment evidence
 * (criterion 3) — and the containment probe is the part most likely to need a
 * second look, because it is the one that depends on the surrounding native
 * chrome rather than on the editor alone.
 */
const CONTAINMENT_ONLY = process.argv.includes('--containment-only');

const PACKAGE = 'com.futo.notes.dev';
const NOTE_TITLE = 'Perf fixture';
const NOTE_FILE = `${NOTE_TITLE}.md`;
/**
 * Keystroke samples per fixture. The loop is byte-for-byte the desktop
 * gauntlet's `measureKeystrokes` (a dispatch, then a rAF), so the numbers mean
 * the same thing on both — which is also why the rAF cannot be dropped to make
 * a run cheaper.
 *
 * The budget-bearing fixtures keep the full 25. The pathological ladder does
 * not: one settled sample on the unchunkable 10k fixture measured 7.9s on the
 * reference phone, so 25 of them at 50k would spend ~20 minutes inside a single
 * leg. 8 samples still supports the same rank rule — it just collapses p95 onto
 * the second-worst sample, which makes the budget HARDER to meet, not easier.
 */
const KEYSTROKE_SAMPLES = 25;
const KEYSTROKE_SAMPLES_PATHOLOGICAL = 8;
const REPORT_DIR = 'tests/editor-gauntlet/local';
const LOCAL_NOTE_PATH = path.join(REPORT_DIR, 'device-perf-note.md');
/** Streaming a 50k-line tail on a low-end phone takes a while; bounded, not open. */
const OPEN_COMPLETE_TIMEOUT_MS = 180_000;

// Two ladders, because the two budgets need different documents.
//
// `*-blocks` fixtures are real-note shaped — blank line between blocks — and
// carry the interactive-first-viewport budget, which is only meaningful on a
// document progressive open will cut. `*-lines` fixtures are the desktop
// floor's own generator (differential-locked in editorDevicePerf.test.mjs) so
// the device numbers stay comparable to MILKDOWN_FLOOR_FIXTURES'; they have no
// blank line anywhere, so `planMarkdownChunks` declines them and they load
// whole. That measured 15.7s at 10k lines on this phone, which is why they
// carry the scaling and keystroke assertions and NOT the 1s gate — matching
// plan §5, where the notes that offer no safe boundary "open no worse than they
// do today" instead of being held to the interactive budget.
//
// The adversarial byte fixtures stay desktop-only: §2's note-size population
// says nothing about benchmark-shaped documents, and shipping 10 MiB through
// a phone's CDP socket measures the socket more than the editor.
function fixturePlan() {
  const plan = [
    { name: '1000-lines-blocks', openPolicy: { kind: 'hard' }, build: () => blockFixture(1_000) },
    { name: '10000-lines-blocks', openPolicy: { kind: 'hard' }, build: () => blockFixture(10_000) },
  ];
  const realNote = resolveRealNote();
  if (realNote) {
    plan.push({
      name: realNote.name,
      // A real note is a real-note size by definition: the 1s budget applies.
      openPolicy: { kind: 'hard' },
      build: () => realNote.content,
    });
  }
  plan.push(
    // The reference for the cliff check below. Reported, never open-gated.
    { name: '10000-lines', openPolicy: { kind: 'measured' }, build: () => lineFixture(10_000) },
    {
      name: '25000-lines',
      openPolicy: { kind: 'linear', reference: '10000-lines' },
      build: () => lineFixture(25_000),
    },
  );
  /* 50k lines is what plan §5 names, and on the reference phone it is not
   * affordable in a routine run: a 50k unchunkable document did not finish its
   * leg inside 20 minutes there (the open is a whole-document parse and each
   * settled-to-paint sample costs tens of seconds at that size, with the
   * renderer at 560 MB on a 2.8 GB phone). The cliff check is a RATIO, so
   * 10k→25k proves the same "scales linearly, no cliff" property at a fraction
   * of the cost; `--stress` adds the 50k rung for anyone who wants the number
   * §5 quotes. Making it opt-in is a cost decision, not a weaker assertion —
   * the same policy is applied to whichever rungs run. */
  if (STRESS) {
    plan.push({
      name: '50000-lines',
      openPolicy: { kind: 'linear', reference: '10000-lines' },
      build: () => lineFixture(50_000),
    });
  }
  return { plan, realNote };
}

/** The local, uncommitted big-note fixture, or null with a loud notice. */
function resolveRealNote() {
  const explicit = process.env.FUTO_PERF_NOTE;
  const file = explicit || (existsSync(LOCAL_NOTE_PATH) ? LOCAL_NOTE_PATH : null);
  if (!file) {
    console.log(
      `NOTE: no real-note fixture — set $FUTO_PERF_NOTE or place one at ${LOCAL_NOTE_PATH} ` +
        '(it stays local and uncommitted; the directory is gitignored).',
    );
    return null;
  }
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n').length;
  console.log(`Real-note fixture: ${file} (${lines} lines, ${content.length} chars)`);
  return { name: 'real-note', content, lines };
}

// ── CDP: the app's editor WebView ─────────────────────────────────

/** Forward the debug WebView's DevTools socket and return this run's port. */
function forwardDevTools(adb) {
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

/** One CDP session on the editor page, exposing awaited Runtime.evaluate. */
async function connectEditorPage(port) {
  const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page at localhost:${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    /** Evaluate [expression], awaiting promises; throws on a page exception. */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: OPEN_COMPLETE_TIMEOUT_MS + 60_000,
      });
      if (r.exceptionDetails) {
        throw new Error(
          `in-page: ${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`,
        );
      }
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

// ── In-page measurement (the same unit the desktop gauntlet times) ─

/**
 * setContent, then block until the open has fully landed. `setContent` →
 * `applyExternal` → `markOpenStart` clears the previous open's entries
 * SYNCHRONOUSLY, so any entry visible after it belongs to this open — which is
 * what makes polling the measure safe rather than a race.
 */
function openSnippet(markdown) {
  return `
    const md = ${JSON.stringify(markdown)};
    if (!window.FutoEditor) throw new Error('no FutoEditor on this page');
    window.FutoEditor.setContent(md);
    const deadline = performance.now() + ${OPEN_COMPLETE_TIMEOUT_MS};
    while (performance.getEntriesByName('futo:editor-open-complete').length === 0) {
      if (performance.now() > deadline) throw new Error('open never completed (screen off? app backgrounded?)');
      await new Promise((r) => setTimeout(r, 50));
    }
    /* The document on screen must actually BE the fixture. Every guard between
     * here and the editor dedupes against the live document (hostBoot's
     * setContent, MilkdownEditor's own), and a skipped load leaves a STALE
     * open-complete measure behind — so the poll above returns instantly and
     * every number after it would describe the previous document. That is the
     * silent green M11 forbids, and it is not hypothetical: it is what this
     * runner did on its first --containment-only run. Normalization means the
     * text is not byte-identical, so the check is a loose size floor. */
    const loadedSize = window.__futoProseMirrorView?.()?.state.doc.content.size ?? 0;
    if (loadedSize < md.length / 2) {
      throw new Error(
        'the fixture did not load: asked for ' + md.length + ' chars, document holds ' +
        loadedSize + ' (starts: ' + JSON.stringify(window.FutoEditor.getContent().slice(0, 60)) + ')',
      );
    }`;
}

/** Load a document and report nothing — used to set up the containment probe. */
function loadExpression(markdown) {
  return `(async () => {${openSnippet(markdown)}
    return true;
  })()`;
}

function measureExpression(markdown, samples) {
  return `(async () => {${openSnippet(markdown)}
    const duration = (name) => performance.getEntriesByName(name)[0]?.duration ?? null;
    const view = window.__futoProseMirrorView?.();
    if (!view) throw new Error('no ProseMirror view (did the page load the CodeMirror editor?)');
    const synchronousSamplesMs = [];
    const settledToPaintSamplesMs = [];
    for (let i = 0; i < ${samples}; i += 1) {
      const t0 = performance.now();
      view.dispatch(view.state.tr.insertText('x'));
      synchronousSamplesMs.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(() => r()));
      settledToPaintSamplesMs.push(performance.now() - t0);
    }
    return {
      interactiveMs: duration('futo:editor-open-interactive'),
      completeMs: duration('futo:editor-open-complete'),
      synchronousSamplesMs,
      settledToPaintSamplesMs,
    };
  })()`;
}

/**
 * The containment stylesheet, verified inside the real editor chrome: the rule
 * is active on block children, the caret can enter a region the browser has
 * skipped, and the scroller's geometry is sane (the WebView sits inside native
 * Compose chrome — the nested-scroll arrangement the bare-page probe could not
 * see).
 */
const CONTAINMENT_EXPRESSION = `(async () => {
  const editor = document.querySelector('.ProseMirror');
  if (!editor) throw new Error('no .ProseMirror');
  const view = window.__futoProseMirrorView?.();
  if (!view) throw new Error('no ProseMirror view');

  /* WHICH element scrolls is the question this leg exists to answer.
   * MilkdownEditor.svelte declares '.ProseMirror { height: 100%; overflow-y:
   * auto }', but height:100% only resolves against a definite height chain, and
   * the native shells wrap the editor in their own chrome — so assuming
   * .ProseMirror is the scroller is exactly the "nested scroll containers"
   * assumption the acceptance criterion says to verify rather than trust.
   * Walk out to the nearest ancestor that actually scrolls and report which
   * one it was, so the evidence names the arrangement instead of implying it. */
  const scrollsVertically = (element) => {
    const overflowY = getComputedStyle(element).overflowY;
    return (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      element.scrollHeight > element.clientHeight + 1
    );
  };
  const describe = (element) =>
    element === document.scrollingElement
      ? 'document.scrollingElement'
      : element.tagName.toLowerCase() +
        (element.className ? '.' + String(element.className).trim().split(/\\s+/).join('.') : '');
  /* Evidence that the probe is looking at the document it thinks it is: a
   * containment result over a short note would be meaningless, and a silently
   * unloaded fixture is exactly the way this leg could go falsely green. */
  const topLevelBlocks = editor.querySelectorAll(':scope > *').length;
  const docSize = view.state.doc.content.size;

  const chain = [];
  let scroller = null;
  for (let element = editor; element; element = element.parentElement) {
    chain.push({
      element: describe(element),
      overflowY: getComputedStyle(element).overflowY,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    });
    if (!scroller && scrollsVertically(element)) scroller = element;
  }
  const documentScroller = document.scrollingElement ?? document.documentElement;
  if (!scroller && documentScroller.scrollHeight > documentScroller.clientHeight + 1) {
    scroller = documentScroller;
  }
  if (!scroller) {
    throw new Error(
      'nothing on the page scrolls vertically (blocks=' + topLevelBlocks + ', docSize=' + docSize +
      '): ' + JSON.stringify(chain),
    );
  }

  const blocks = editor.querySelectorAll(':scope > *');
  const middle = blocks[Math.floor(blocks.length / 2)];
  const computed = getComputedStyle(middle);

  /* Focus first. A caret move is something a FOCUSED editor does, ProseMirror
   * only syncs the DOM selection for a focused view, and the desktop
   * counterpart in tests/editor-embed-milkdown.spec.ts focuses before it
   * dispatches — leaving it out here would have made the two probes measure
   * different things. */
  window.FutoEditor.focus();
  scroller.scrollTop = 0;
  await new Promise((r) => requestAnimationFrame(() => r()));
  const before = scroller.scrollTop;
  const selection = view.state.selection.constructor.near(
    view.state.doc.resolve(view.state.doc.content.size),
  );
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  /* Give the scroll AND the rendering of the blocks content-visibility had
   * skipped a bounded number of frames to settle. A phone needs more than the
   * one frame a desktop does, and waiting on the condition rather than a sleep
   * is the rule (AGENTS.md M15). */
  for (let frame = 0; frame < 60; frame += 1) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    if (scroller.scrollTop > before) break;
  }
  await new Promise((r) => requestAnimationFrame(() => r()));
  /* Assert on the block the CARET landed in, not on the document's last child.
   * They are usually different: the preset keeps a trailing placeholder
   * paragraph after the content, and ProseMirror scrolls the CARET into view,
   * so the very last element legitimately stays just below the fold. What the
   * criterion asks is that the caret's own destination is real rendered
   * content rather than a contain-intrinsic-size estimate. */
  const caretPos = view.state.selection.from;
  let caretBlock = view.domAtPos(caretPos).node;
  if (caretBlock.nodeType === 3) caretBlock = caretBlock.parentElement;
  while (caretBlock && caretBlock.parentElement !== editor) caretBlock = caretBlock.parentElement;
  if (!caretBlock) throw new Error('could not find the caret\\'s top-level block');
  const viewportOf = () =>
    scroller === documentScroller
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
  const onScreen = () => {
    const box = caretBlock.getBoundingClientRect();
    const view = viewportOf();
    return box.top < view.bottom && box.bottom > view.top;
  };
  const rect = caretBlock.getBoundingClientRect();
  const firstScrollOnScreen = onScreen();

  /* Then scroll again, and report whether that recovers it.
   *
   * This separates two very different failures. Rendering the blocks that
   * content-visibility had skipped replaces each 24px ESTIMATE with a real
   * height, so the content grows underneath a scroll that was computed against
   * the estimates and the destination drifts down (scrollHeight moved 184209 ->
   * 184405 on the reference phone). A second scroll against the settled layout
   * lands correctly; if it did NOT, the caret would be genuinely unreachable,
   * which is a different and much worse thing. Both are reported so a
   * regression in either cannot hide behind the other. */
  view.dispatch(view.state.tr.scrollIntoView());
  for (let frame = 0; frame < 60; frame += 1) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    if (onScreen()) break;
  }
  const settledOnScreen = onScreen();
  return {
    contentVisibility: computed.getPropertyValue('content-visibility'),
    containIntrinsicSize: computed.getPropertyValue('contain-intrinsic-size'),
    topLevelBlocks,
    docSize,
    scroller: describe(scroller),
    scrollChain: chain,
    scrolled: scroller.scrollTop > before,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    caretBlockHeight: rect.height,
    caretBlockOnScreen: firstScrollOnScreen,
    caretBlockOnScreenAfterSettle: settledOnScreen,
  };
})()`;

// ── Device stories ────────────────────────────────────────────────

function requireSerial() {
  if (!process.env.ANDROID_SERIAL) {
    console.error(
      'Set $ANDROID_SERIAL to the claimed device (the low-end reference phone; `adb devices -l`).\n' +
        'Pool emulators come from: just qa-claim android',
    );
    process.exit(1);
  }
}

/** Tap the seeded note in the list; its label may carry a preview suffix. */
async function openSeededNote(device) {
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

async function main() {
  requireSerial();
  const device = createAndroidDevice({ pkg: PACKAGE });
  const { adb } = device;
  device.requireReady();

  const model = adb.shell('getprop ro.product.model').trim();
  console.log(
    `Device: ${model} (${adb.serial}, Android ${adb.shell('getprop ro.build.version.release').trim()})`,
  );

  // rAF needs frames: wake the screen and dismiss the keyguard, or every
  // settled sample (and the streamed open itself) stalls silently (M21).
  adb.shell('input keyevent KEYCODE_WAKEUP');
  adb.shell('wm dismiss-keyguard', { allowFailure: true });

  device.relaunch();
  const state = await device.waitForState(
    'the note shell',
    (snapshot) => snapshot.shellVisible || snapshot.onboarding,
    { timeoutMs: 60_000 },
  );
  if (state.onboarding) {
    // First-run picker on a fresh install: app storage keeps the run
    // self-contained (nothing outside the app's own sandbox).
    await device.tap('App storage');
    await device.tap('Continue');
    await device.waitForState('the shell after onboarding', (s) => s.shellVisible, {
      timeoutMs: 60_000,
    });
  }
  const vaultPath = (await device.state()).vaultPath;
  if (!vaultPath) throw new Error('the app reported no vaultPath');

  // Seed a small note; every fixture is then loaded through FutoEditor in the
  // SAME open editor, which is the unit both floors time. Keystrokes autosave
  // fixture text into this file (dev vault only); it is removed afterwards.
  const notePath = `${vaultPath}/${NOTE_FILE}`;
  adb.writeFile(notePath, `# ${NOTE_TITLE}\n`);
  device.relaunch();
  await device.waitForState('the note list', (s) => s.shellVisible, { timeoutMs: 60_000 });
  await openSeededNote(device);

  const socketReady = await device.waitFor(
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
  const cdp = await connectEditorPage(socketReady);

  const { plan, realNote } = fixturePlan();
  const results = [];
  let containment = null;
  try {
    /* Wait for the HOST's own load to have landed, not merely for the bridge to
     * exist. The shell calls `FutoEditor.initialize` with the note's content
     * shortly after the page is ready, and it overwrites whatever is in the
     * editor — so a fixture pushed in that window is silently replaced by the
     * seeded note, and the measures reported belong to the host's open instead.
     * That is what happened before this wait existed: the FIRST fixture of
     * every run reported the 1-line seeded note's numbers (interactive equal to
     * complete, a signature no chunkable fixture can produce). Keying the wait
     * on the seeded title means the host has demonstrably finished. */
    await device.waitFor(
      "the host's own initialize to land the seeded note",
      async () =>
        cdp.evaluate(
          `Boolean(window.FutoEditor && window.__futoProseMirrorView?.()) &&
             window.FutoEditor.getContent().includes(${JSON.stringify(NOTE_TITLE)})`,
        ),
      { timeoutMs: 30_000 },
    );

    for (const fixture of CONTAINMENT_ONLY ? [] : plan) {
      const content = fixture.build();
      process.stdout.write(`  ${fixture.name} … `);
      const samples =
        fixture.openPolicy.kind === 'hard' ? KEYSTROKE_SAMPLES : KEYSTROKE_SAMPLES_PATHOLOGICAL;
      let measured;
      try {
        measured = await cdp.evaluate(measureExpression(content, samples));
      } catch (error) {
        /* The editor threw on the document rather than opening it. Record it
         * and keep going: one refused fixture must neither abort the other
         * measurements nor pass silently (evaluateDeviceFloor scores this as a
         * `load-failure` violation). On the maintainer's real note this is
         * expected to be #101 — `Cannot close 'paragraph': a different token
         * ('wikilink') is open`, which the plan's §5 census recorded for any
         * note whose line ends in `!`.
         *
         * This also catches a fixture that STALLED rather than threw (a phone
         * that slept mid-run stops delivering rAF, and the CDP call times out),
         * so read the recorded message before believing the word "load": a
         * parse error and a timeout say plainly different things. */
        const loadError = error instanceof Error ? error.message : String(error);
        results.push({ fixture: fixture.name, lines: content.split('\n').length, loadError });
        console.log(`LOAD FAILED — ${loadError.split('\n')[0]}`);
        // The page's editor state is now whatever the failed parse left behind;
        // put a trivial document back so the next fixture starts from a known
        // one rather than inheriting the wreckage.
        await cdp.evaluate(`window.FutoEditor.setContent(${JSON.stringify('# reset\n')})`);
        continue;
      }
      const result = {
        fixture: fixture.name,
        lines: content.split('\n').length,
        bytes: Buffer.byteLength(content, 'utf8'),
        interactiveMs: measured.interactiveMs,
        completeMs: measured.completeMs,
        keystrokeSynchronousP95Ms: percentile95(measured.synchronousSamplesMs),
        keystrokeSettledToPaintP95Ms: percentile95(measured.settledToPaintSamplesMs),
      };
      results.push(result);
      console.log(
        `interactive ${Math.round(result.interactiveMs)}ms, complete ${Math.round(result.completeMs)}ms, ` +
          `keystroke p95 ${result.keystrokeSynchronousP95Ms.toFixed(1)}ms (settled ${result.keystrokeSettledToPaintP95Ms.toFixed(1)}ms)`,
      );
    }

    // Containment, in a document that actually has thousands of top-level
    // blocks to skip. Loaded explicitly rather than inheriting whatever the
    // last fixture left: `lineFixture` fuses into a handful of huge blocks, so
    // measuring containment on it would prove nothing either way.
    await cdp.evaluate(loadExpression(blockFixture(10_000)));
    containment = await cdp.evaluate(CONTAINMENT_EXPRESSION);
    console.log(
      `  containment: content-visibility=${containment.contentVisibility}, ` +
        `scroller=${containment.scroller}, caret-to-end scrolled=${containment.scrolled} ` +
        `(scrollTop ${Math.round(containment.scrollTop)}), ` +
        `caret block ${Math.round(containment.caretBlockHeight)}px ` +
        `on-screen=${containment.caretBlockOnScreen} settled=${containment.caretBlockOnScreenAfterSettle}`,
    );
  } finally {
    cdp.close();
    // Tear down only what this run created (M25): our forward, our note.
    adb.adb(['forward', '--remove', `tcp:${socketReady}`]);
    adb.forceStop();
    adb.shell(`rm -f ${quoteForDeviceShell(notePath)}`, { allowFailure: true });
  }

  /* --containment-only ran no fixtures, so there are no budgets to score. Left
   * as `plan` it would report five missing-measurement violations and exit red
   * every single time, which trains a reader to ignore this mode's exit code —
   * and an exit code nobody reads is worth nothing when the containment leg
   * really does break. */
  const violations = evaluateDeviceFloor(CONTAINMENT_ONLY ? [] : plan, results);
  const containmentFailures = [];
  if (containment.contentVisibility !== 'auto') {
    containmentFailures.push(
      `content-visibility is "${containment.contentVisibility}", not "auto" — the containment stylesheet is not active in this chrome`,
    );
  }
  /* The gate is the SETTLED state — what a user is left looking at — because
   * the first scroll legitimately lands short while content-visibility's size
   * estimates are still being replaced by real heights (see the probe). The
   * first-scroll result is recorded in the report rather than asserted, and the
   * drift it represents is written up in plan §5's T9 outcome as an open item
   * rather than quietly accepted. */
  if (
    !containment.scrolled ||
    !containment.caretBlockOnScreenAfterSettle ||
    containment.caretBlockHeight <= 0
  ) {
    containmentFailures.push(
      `caret into the offscreen end did not land on rendered content: ${JSON.stringify(containment)}`,
    );
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const report = {
    device: { model, serial: adb.serial },
    budget: DEVICE_BUDGET,
    realNoteFixture: realNote ? { lines: realNote.lines } : null,
    results,
    containment,
    violations,
    containmentFailures,
  };
  writeFileSync(
    path.join(REPORT_DIR, 'android-device-perf.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`Report: ${path.join(REPORT_DIR, 'android-device-perf.json')}`);

  const failures = [...violations.map((v) => `${v.fixture}: ${v.detail}`), ...containmentFailures];
  if (!realNote) {
    console.log(
      'PARTIAL: the synthetic ladder ran without the real-note fixture (see NOTE above).',
    );
  }
  if (failures.length > 0) {
    console.error(`\nFAIL — the device floor did not hold:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nPASS — every device budget held.');
}

await main();
