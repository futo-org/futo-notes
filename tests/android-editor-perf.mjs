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
 * - the FIRST focus after an open — the tap that starts typing — answering
 *   under the same 1s budget at real-note sizes. A `content-visibility`
 *   containment rule used to stall it for seconds (docs/spec/editor.md,
 *   Performance); this is what keeps that from coming back.
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
import { connectPage, measureExpression } from './lib/editorDevicePerfSnippets.mjs';

/**
 * Flags, parsed once and strictly: an unrecognised argument fails the run
 * rather than being ignored, so `--stres` cannot look like a 50k run that
 * quietly measured 25k instead.
 */
const FLAGS = new Set(['--stress']);
const unknownArgs = process.argv.slice(2).filter((arg) => !FLAGS.has(arg));
if (unknownArgs.length > 0) {
  console.error(
    `Unrecognised argument(s): ${unknownArgs.join(' ')}\nSupported: ${[...FLAGS].join(', ')}`,
  );
  process.exit(2);
}
const STRESS = process.argv.includes('--stress');

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

// Two ladders, because the two budgets need different documents.
//
// `*-blocks` fixtures are real-note shaped — blank line between blocks — and
// carry the full `hard` policy: interactive-first-viewport AND first focus.
// `*-lines` fixtures are the desktop floor's own generator (differential-
// locked in editorDevicePerf.test.mjs) so the device numbers stay comparable
// to MILKDOWN_FLOOR_FIXTURES'; they have no blank line anywhere. Before
// markdownChunks.ts learned to cut at a non-blank "hard starter" (a column-0
// heading, fence, blockquote, or interrupting list item), `planMarkdownChunks`
// declined them outright and they loaded whole — that measured 15.7s at 10k
// lines on this phone. They chunk now: the list-item and blockquote lines this
// generator cycles through are hard starters (verified in
// markdownChunks.test.ts and editorDevicePerf.test.mjs), so `10000-lines` and
// `25000-lines` now carry `openPolicy.interactive: 'hard'` too — the
// interactive budget is meaningful for them, matching plan §5's point that a
// document offering a safe boundary opens progressively regardless of shape.
// They still do NOT carry the `hard` policy's first-focus check: first focus
// after a full load is Chromium's editable-focus work over the fully rendered
// document (containment was retired 2026-09-05), measured at 1.6s / 3.9s at
// 10k/25k lines on the 2026-09-06 gate run and reported but not gated — see
// `lineFixture`'s own comment in editorDevicePerf.mjs.
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
    // The reference for the cliff check below. Its open is now held to the
    // interactive budget too (it chunks — see the comment above), but not to
    // first focus.
    {
      name: '10000-lines',
      openPolicy: { kind: 'measured', interactive: 'hard' },
      build: () => lineFixture(10_000),
    },
    {
      name: '25000-lines',
      openPolicy: { kind: 'linear', reference: '10000-lines', interactive: 'hard' },
      build: () => lineFixture(25_000),
    },
  );
  /* 50k lines is what plan §5 names, and on the reference phone it is still
   * not affordable in a routine run — but not because the open is unmeasurable
   * any more. It chunks now, the same as 10k/25k (see the comment above), so
   * this is held to the interactive budget too. The cost that remains is the
   * KEYSTROKE samples: each settled-to-paint sample is a layout pass over a
   * ~25,000-block document, slow enough on its own that the routine 10k/25k
   * ladder already proves the
   * same "scales linearly, no cliff" property (a RATIO check) at a fraction of
   * the wall-clock cost. `--stress` adds the 50k rung for anyone who wants the
   * number §5 quotes. Making it opt-in is a cost decision, not a weaker
   * assertion — the same policy is applied to whichever rungs run. */
  if (STRESS) {
    plan.push({
      name: '50000-lines',
      openPolicy: { kind: 'linear', reference: '10000-lines', interactive: 'hard' },
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

/** One CDP session on the editor page (the shared client, tests/lib/editorDevicePerfSnippets.mjs). */
async function connectEditorPage(port) {
  const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page at localhost:${port}`);
  return connectPage(page.webSocketDebuggerUrl, WebSocket);
}

// ── In-page measurement: tests/lib/editorDevicePerfSnippets.mjs (shared with the quick loop) ─

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

    for (const fixture of plan) {
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
        firstFocusMs: measured.firstFocusMs,
        synchronousSamplesMs: measured.synchronousSamplesMs,
        settledToPaintSamplesMs: measured.settledToPaintSamplesMs,
        keystrokeSynchronousP95Ms: percentile95(measured.synchronousSamplesMs),
        keystrokeSettledToPaintP95Ms: percentile95(measured.settledToPaintSamplesMs),
      };
      results.push(result);
      console.log(
        `interactive ${Math.round(result.interactiveMs)}ms, complete ${Math.round(result.completeMs)}ms, ` +
          `first focus ${Math.round(result.firstFocusMs)}ms, ` +
          `keystroke p95 ${result.keystrokeSynchronousP95Ms.toFixed(1)}ms (settled ${result.keystrokeSettledToPaintP95Ms.toFixed(1)}ms)`,
      );
    }
  } finally {
    cdp.close();
    // Tear down only what this run created (M25): our forward, our note.
    adb.adb(['forward', '--remove', `tcp:${socketReady}`]);
    adb.forceStop();
    adb.shell(`rm -f ${quoteForDeviceShell(notePath)}`, { allowFailure: true });
  }

  const violations = evaluateDeviceFloor(plan, results);

  mkdirSync(REPORT_DIR, { recursive: true });
  const report = {
    device: { model, serial: adb.serial },
    budget: DEVICE_BUDGET,
    realNoteFixture: realNote ? { lines: realNote.lines } : null,
    results,
    violations,
  };
  writeFileSync(
    path.join(REPORT_DIR, 'android-device-perf.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`Report: ${path.join(REPORT_DIR, 'android-device-perf.json')}`);

  const failures = violations.map((v) => `${v.fixture}: ${v.detail}`);
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
