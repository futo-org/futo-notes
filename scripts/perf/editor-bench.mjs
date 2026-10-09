#!/usr/bin/env node
// Editor hill-climb benchmark: a fixed script of editor interactions in headless
// Chromium, scored by how much work the BROWSER does (elements restyled, layout
// objects laid out), not by wall-clock time.
//
//   node --experimental-strip-types scripts/perf/editor-bench.mjs [--runs 3] [--no-build] [--json <file>]
//       [--baseline <file>] [--only <scenario,...>] [--check] [--headed]
//
// The score is one instrumented pass, all scenarios in parallel. `--runs N`
// adds N clean wall-clock passes after it (`--runs 0`: counts only, the fast
// loop). `--check` runs the count pass twice and fails if any count moved.
//
// Why counts: on Chromium a keystroke is 81-96 % renderer style/layout and
// ~0.5 ms editor JS (docs/perf/keystroke-attribution.md), so a JS microbench
// would climb the wrong hill, and wall-clock milliseconds on a shared machine
// are too noisy to judge a 3 % change. The count of elements the browser had
// to restyle is the same every run for the same code, so it can be climbed.
// Wall-clock is reported beside it, for intuition only.
//
// Every scenario's final markdown is hashed. `--baseline <file>` (a previous
// `--json` output) fails the run if any hash differs: an "optimization" that
// changes what the editor writes is a behavior change, not a win.
//
// It drives the exact single-file editor.html the native shells ship, with the
// Playwright suites' fake native host (tests/lib/editorEmbedHost.ts).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { installFakeAndroidHost } from '../../tests/lib/editorEmbedHost.ts';

const BUNDLE = path.resolve('build/native-editor/editor.html');
const URL = `file://${BUNDLE}?test`;
// A phone-sized viewport: the embed is the mobile shells' editor.
const VIEWPORT = { width: 412, height: 915 };

const args = process.argv.slice(2);
const opt = {
  runs: 3,
  check: false,
  build: true,
  json: null,
  baseline: null,
  only: null,
  headed: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--runs') opt.runs = Number(args[++i]);
  else if (a === '--no-build') opt.build = false;
  else if (a === '--check') opt.check = true;
  else if (a === '--json') opt.json = args[++i];
  else if (a === '--baseline') opt.baseline = args[++i];
  else if (a === '--only') opt.only = args[++i].split(',');
  else if (a === '--headed') opt.headed = true;
  else {
    console.error(`Unrecognised argument: ${a}`);
    process.exit(2);
  }
}

// ── Fixture: a deterministic note with every common block kind ─────────────

function richNote(blocks, seed) {
  const out = [];
  for (let i = 0; i < blocks; i++) {
    const n = i + seed;
    switch (i % 10) {
      case 0:
        out.push(`## Section ${n}`);
        break;
      case 1:
      case 5:
        out.push(
          `Paragraph ${n} has **bold**, *italic*, \`code\`, a [link](https://example.test/${n}) and #tag${n % 7} in it.`,
        );
        break;
      case 2:
        out.push(`- item ${n}\n- item ${n} two\n  - nested ${n}\n- item ${n} three`);
        break;
      case 3:
        out.push(`- [ ] task ${n}\n- [x] done ${n}`);
        break;
      case 4:
        out.push(`> quoted ${n}\n> second line`);
        break;
      case 6:
        out.push(`1. first ${n}\n2. second ${n}`);
        break;
      case 7:
        out.push('```js\nconst x' + n + ' = ' + n + ';\nconsole.log(x' + n + ');\n```');
        break;
      case 8:
        out.push(`| a | b |\n| --- | --- |\n| ${n} | [[Note ${n}]] |`);
        break;
      default:
        out.push(
          `Plain line ${n} of ordinary prose that wraps on a phone-width screen, more or less.`,
        );
    }
  }
  return out.join('\n\n') + '\n';
}

const NOTE_SMALL = richNote(40, 0);
const NOTE_LARGE = richNote(2000, 0);
const NOTE_OTHER = richNote(400, 5000);

// ── Page helpers ──────────────────────────────────────────────────────────

// One animation frame. A rAF callback runs before that frame's style, layout
// and paint, and the reply to Playwright is only processed after the frame
// finishes, so the next input never lands inside the previous one's frame.
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

// Waits until the editor has nothing queued: four full (50 ms) idle periods in
// a row. The open primes its serializer and streams its tail in idle slices
// sized by wall time, so a scenario that stops measuring while they still run
// counts a load-dependent share of them (switch-note's JS calls moved 17 %
// between two passes before this). Settling before AND after the measured
// step puts all of a step's background work inside its count, however it was
// sliced. Four periods is the editor's own 200 ms idle-callback timeout.
async function settle(page) {
  await page.evaluate(async () => {
    const start = performance.now();
    let quiet = 0;
    while (quiet < 4) {
      if (performance.now() - start > 10_000) throw new Error('editor never went idle');
      const left = await new Promise((r) => requestIdleCallback((d) => r(d.timeRemaining())));
      quiet = left >= 49 ? quiet + 1 : 0;
    }
  });
}

async function waitOpenComplete(page) {
  await page.waitForFunction(
    () => performance.getEntriesByName('futo:editor-open-complete').length > 0,
    null,
    { timeout: 60_000, polling: 'raf' },
  );
}

async function setContent(page, noteId, markdown) {
  await page.evaluate(
    ([id, md]) => {
      performance.clearMeasures('futo:editor-open-complete');
      window.FutoEditor.setContent(id, md);
    },
    [noteId, markdown],
  );
  await waitOpenComplete(page);
  await frame(page);
}

// Waits for the debounced `change` post that follows an edit: the serialize it
// carries is part of what an edit costs, so it lands inside the measurement.
async function waitChange(page, since) {
  await page.waitForFunction(
    (n) => window.__msgs.filter((m) => m.type === 'change').length > n,
    since,
    { timeout: 10_000, polling: 'raf' },
  );
}
const changeCount = (page) =>
  page.evaluate(() => window.__msgs.filter((m) => m.type === 'change').length);

// Places the caret by a real click on the Nth paragraph's text and waits until
// ProseMirror has read it (see withCaretObserved in editorEmbedHost.ts).
async function clickInto(page, selector, nth) {
  await page.evaluate(() => {
    window.__caretMoves = 0;
    document.addEventListener('selectionchange', () => (window.__caretMoves += 1));
  });
  const el = page.locator(`.ProseMirror ${selector}`).nth(nth);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.waitForFunction(() => window.__caretMoves > 0, null, { polling: 'raf' });
  await page.keyboard.press('End');
  await frame(page);
}

// One key per rendered frame: how a human types, and it keeps the style
// recalcs per key from batching differently run to run.
async function typeKeys(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await frame(page);
  }
}
async function pressKeys(page, key, times) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await frame(page);
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────
// `setup` runs untimed; `run` is measured. Each starts from a fresh page.

const SCENARIOS = [
  {
    name: 'open-large',
    note: '2000-block note, setContent → open complete',
    setup: async () => {},
    run: async (page) => setContent(page, 'large', NOTE_LARGE),
  },
  {
    name: 'switch-note',
    note: 'large note open, switch to a 400-block note',
    setup: async (page) => setContent(page, 'large', NOTE_LARGE),
    run: async (page) => setContent(page, 'other', NOTE_OTHER),
  },
  {
    name: 'type-small',
    note: '40-block note, 10 chars at the end of a paragraph',
    setup: async (page) => {
      await setContent(page, 'small', NOTE_SMALL);
      await clickInto(page, 'p', 1);
    },
    run: async (page) => {
      const n = await changeCount(page);
      await typeKeys(page, ' typed in.');
      await waitChange(page, n);
    },
  },
  {
    name: 'type-large',
    note: '2000-block note, 10 chars at the end of a paragraph',
    setup: async (page) => {
      await setContent(page, 'large', NOTE_LARGE);
      await clickInto(page, 'p', 1);
    },
    run: async (page) => {
      const n = await changeCount(page);
      await typeKeys(page, ' typed in!');
      await waitChange(page, n);
    },
  },
  {
    name: 'enter-list-large',
    note: '2000-block note, Enter + 2 chars ×3 in a list',
    setup: async (page) => {
      await setContent(page, 'large', NOTE_LARGE);
      await clickInto(page, 'li p', 0);
    },
    run: async (page) => {
      const n = await changeCount(page);
      for (let i = 0; i < 3; i++) {
        await pressKeys(page, 'Enter', 1);
        await typeKeys(page, `n${i}`);
      }
      await waitChange(page, n);
    },
  },
  {
    name: 'backspace-join-large',
    note: '2000-block note, Backspace ×6 across a block boundary',
    setup: async (page) => {
      await setContent(page, 'large', NOTE_LARGE);
      await clickInto(page, 'p', 2);
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await frame(page);
    },
    run: async (page) => {
      const n = await changeCount(page);
      await pressKeys(page, 'Backspace', 6);
      await waitChange(page, n);
    },
  },
];

// ── Measurement ──────────────────────────────────────────────────────────

const METRIC_KEYS = [
  'RecalcStyleCount',
  'LayoutCount',
  'RecalcStyleDuration',
  'LayoutDuration',
  'ScriptDuration',
  'TaskDuration',
];

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(
    list.filter((m) => METRIC_KEYS.includes(m.name)).map((m) => [m.name, m.value]),
  );
}

async function startTrace(cdp) {
  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: ['devtools.timeline'],
      recordMode: 'recordAsMuchAsPossible',
    },
    transferMode: 'ReturnAsStream',
  });
}

async function stopTrace(cdp) {
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let text = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    text += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.traceEvents;
}

// Sums the renderer's own accounting of the work: elements whose style was
// recomputed, and the objects in scope of each layout. A keystroke dirties a
// handful of objects (`dirtyObjects`), but when the layout root is the whole
// document the pass covers every object in it (`totalObjects`), and that scope
// is what grows with note length.
function traceWork(events) {
  let styledElements = 0;
  let layoutScope = 0;
  for (const e of events) {
    if (e.name === 'UpdateLayoutTree' && e.args?.elementCount != null)
      styledElements += e.args.elementCount;
    if (e.name === 'Layout' && e.args?.beginData?.totalObjects != null)
      layoutScope += e.args.beginData.totalObjects;
  }
  return { styledElements, layoutScope };
}

// V8 precise coverage counts every function invocation exactly: the closest
// thing to an instruction count JavaScript offers, and as repeatable.
async function startCalls(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: false,
    allowTriggeredUpdates: false,
  });
  await cdp.send('Profiler.takePreciseCoverage'); // resets the counters
}
async function takeCalls(cdp) {
  const { result } = await cdp.send('Profiler.takePreciseCoverage');
  await cdp.send('Profiler.stopPreciseCoverage');
  let calls = 0;
  for (const script of result) for (const fn of script.functions) calls += fn.ranges[0].count;
  return calls;
}

async function runScenario(browser, scenario, instrument) {
  const t0 = performance.now();
  const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => window.__msgs?.some((m) => m.type === 'ready'));
  const version = await page.evaluate(() => window.__msgs.find((m) => m.type === 'ready').version);
  await page.evaluate(
    (v) =>
      window.FutoEditor.initialize(
        JSON.stringify({
          bridgeVersion: v,
          noteId: 'boot',
          theme: 'light',
          content: '',
          nativeToolbar: true,
          contentPaddingInlinePx: 14,
        }),
      ),
    version,
  );
  await frame(page);
  const tLoaded = performance.now();
  await scenario.setup(page);
  await settle(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (instrument) {
    await startCalls(cdp);
    await startTrace(cdp);
  }
  const before = await metrics(cdp);
  const tRun = performance.now();
  await scenario.run(page);
  const wallMs = performance.now() - tRun;
  await settle(page);
  const after = await metrics(cdp);
  const work = instrument ? traceWork(await stopTrace(cdp)) : {};
  const jsCalls = instrument ? await takeCalls(cdp) : undefined;

  const markdown = await page.evaluate(() => window.__futoTest.readDocument());
  await context.close();
  return {
    styledElements: work.styledElements,
    layoutScope: work.layoutScope,
    jsCalls,
    styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
    layouts: after.LayoutCount - before.LayoutCount,
    wallMs,
    styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
    layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
    scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
    hash: createHash('sha256').update(markdown).digest('hex').slice(0, 12),
    phaseMs: {
      load: tLoaded - t0,
      setup: tRun - tLoaded,
      run: wallMs,
      total: performance.now() - t0,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const spread = (xs) => {
  const m = median(xs);
  return m === 0 ? 0 : ((Math.max(...xs) - Math.min(...xs)) / m) * 100;
};

const tStart = performance.now();
let buildMs = 0;
if (opt.build) {
  const t = performance.now();
  execFileSync(
    path.resolve('node_modules/.bin/vite'),
    ['build', '--config', 'vite.editor.config.ts', '--logLevel', 'error'],
    { stdio: 'inherit' },
  );
  buildMs = performance.now() - t;
}
if (!existsSync(BUNDLE)) throw new Error(`no bundle at ${BUNDLE}; run without --no-build`);

const tLaunch = performance.now();
const browser = await chromium.launch({ headless: !opt.headed });
const launchMs = performance.now() - tLaunch;

const scenarios = opt.only ? SCENARIOS.filter((s) => opt.only.includes(s.name)) : SCENARIOS;

// Pass 1, the score: one instrumented run per scenario, all in parallel, each
// in its own browser (Chromium traces one session per browser at a time). The
// counts do not depend on timing, so neither concurrency nor a second run
// changes them (`--check` re-runs this pass to prove it).
const tCounts = performance.now();
const countPass = async () =>
  Object.fromEntries(
    await Promise.all(
      scenarios.map(async (s) => {
        const own = await chromium.launch({ headless: !opt.headed });
        try {
          return [s.name, await runScenario(own, s, true)];
        } finally {
          await own.close();
        }
      }),
    ),
  );
const counts = await countPass();
const countsMs = performance.now() - tCounts;
// Near-exact rather than exact: the progressive open sizes its chunks by a
// time budget and timers fire a few more or fewer times, which moves a count
// by ~0.1 % at most (measured 2026-10-09). A real change is well above this.
const NOISE_PCT = 0.5;
let unstable = [];
let maxDriftPct = 0;
if (opt.check) {
  const again = await countPass();
  for (const s of scenarios) {
    if (again[s.name].hash !== counts[s.name].hash)
      unstable.push(`${s.name}.hash: ${counts[s.name].hash} vs ${again[s.name].hash}`);
    for (const f of ['styledElements', 'layoutScope', 'jsCalls']) {
      const a = counts[s.name][f];
      const b = again[s.name][f];
      const pct = a === b ? 0 : (Math.abs(a - b) / Math.max(a, b)) * 100;
      maxDriftPct = Math.max(maxDriftPct, pct);
      if (pct > NOISE_PCT) unstable.push(`${s.name}.${f}: ${a} vs ${b} (${pct.toFixed(2)}%)`);
    }
  }
}

// Pass 2, for intuition: uninstrumented wall-clock runs, one at a time.
const tTiming = performance.now();
const timing = Object.fromEntries(scenarios.map((s) => [s.name, []]));
for (let i = 0; i < opt.runs; i++)
  for (const s of scenarios) timing[s.name].push(await runScenario(browser, s, false));
const timingMs = performance.now() - tTiming;
await browser.close();
const totalMs = performance.now() - tStart;

const COUNTS = ['styledElements', 'layoutScope', 'jsCalls'];
const TIMES = ['wallMs', 'styleMs', 'layoutMs', 'scriptMs'];
const summary = {};
for (const s of scenarios) {
  const c = counts[s.name];
  summary[s.name] = { hash: c.hash };
  for (const f of COUNTS) summary[s.name][f] = { median: c[f], spreadPct: 0 };
  const runs = timing[s.name];
  if (runs.length === 0) continue;
  for (const f of TIMES) {
    const xs = runs.map((r) => r[f]);
    summary[s.name][f] = { median: median(xs), spreadPct: spread(xs) };
  }
  if (runs.some((r) => r.hash !== c.hash))
    unstable.push(`${s.name}.hash: timing runs wrote different markdown`);
}

const fmt = (v) => (v == null ? '-' : Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1));
const FIELDS = opt.runs > 0 ? [...COUNTS, ...TIMES] : COUNTS;
console.log(
  `\ncounts: 1 instrumented run (exact); times: median of ${opt.runs} clean runs ±(max-min)/median\n`,
);
console.log(['scenario'.padEnd(22), ...FIELDS.map((f) => f.padStart(15)), '  hash'].join(''));
for (const [name, s] of Object.entries(summary)) {
  const cell = (f) =>
    COUNTS.includes(f) ? fmt(s[f].median) : `${fmt(s[f].median)} ±${Math.round(s[f].spreadPct)}%`;
  console.log(
    [name.padEnd(22), ...FIELDS.map((f) => cell(f).padStart(15)), `  ${s.hash}`].join(''),
  );
}
const totals = Object.fromEntries(
  COUNTS.map((f) => [f, Object.values(summary).reduce((a, s) => a + s[f].median, 0)]),
);
console.log(`\ntotals: ${COUNTS.map((f) => `${f} ${totals[f]}`).join(', ')}`);
console.log(
  `suite: build ${fmt(buildMs)} ms, browser ${fmt(launchMs)} ms, counts pass ${fmt(countsMs)} ms` +
    `${opt.check ? ` (+ check, max drift ${maxDriftPct.toFixed(3)}%)` : ''}, timing passes ${fmt(timingMs)} ms, total ${fmt(totalMs)} ms`,
);
const allRuns = [...Object.values(counts), ...Object.values(timing).flat()];
const phase = (k, rs) => fmt(median(rs.map((r) => r.phaseMs[k])));
console.log(
  `one scenario run: page load ${phase('load', allRuns)} ms, setup ${phase('setup', allRuns)} ms, ` +
    `measured ${phase('run', Object.values(timing).flat().length ? Object.values(timing).flat() : allRuns)} ms`,
);

let failed = false;
for (const u of unstable) {
  console.error(`FAIL not repeatable: ${u}`);
  failed = true;
}
if (opt.baseline) {
  const base = JSON.parse(readFileSync(opt.baseline, 'utf8'));
  for (const [name, s] of Object.entries(summary)) {
    const b = base.summary[name];
    if (!b) continue;
    if (b.hash !== s.hash) {
      console.error(`FAIL ${name}: final markdown changed (${b.hash} → ${s.hash})`);
      failed = true;
    }
    const deltas = COUNTS.map((f) => {
      const d = b[f].median === 0 ? 0 : ((s[f].median - b[f].median) / b[f].median) * 100;
      return `${f} ${b[f].median} → ${s[f].median} (${d >= 0 ? '+' : ''}${d.toFixed(1)}%)`;
    });
    console.log(`${name.padEnd(22)} ${deltas.join('  ')}`);
  }
  // One number to climb: the mean, over scenarios and counts, of current/baseline.
  const ratios = [];
  for (const [name, s] of Object.entries(summary))
    for (const f of COUNTS)
      if (base.summary[name]?.[f]?.median > 0)
        ratios.push(s[f].median / base.summary[name][f].median);
  const score = ratios.reduce((a, r) => a + r, 0) / ratios.length;
  console.log(`\nscore vs baseline: ${score.toFixed(4)} (1.0000 = unchanged, lower is better)`);
}
if (opt.json)
  writeFileSync(
    opt.json,
    JSON.stringify(
      {
        runs: opt.runs,
        timing: { buildMs, launchMs, countsMs, timingMs, totalMs },
        totals,
        summary,
        counts,
        timingRuns: timing,
      },
      null,
      2,
    ),
  );
process.exit(failed ? 1 : 0);
