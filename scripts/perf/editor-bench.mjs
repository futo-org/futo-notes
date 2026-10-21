#!/usr/bin/env node
// Editor hill-climb benchmark: a fixed script of editor interactions in headless
// Chromium, scored by how much work the BROWSER does (elements restyled, layout
// objects laid out), not by wall-clock time.
//
//   node --experimental-strip-types scripts/perf/editor-bench.mjs [--runs 3] [--no-build] [--json <file>]
//       [--baseline <file>] [--only <scenario,...>] [--passes N] [--check] [--headed]
//       [--why <scenario>]
//
// The score is an instrumented pass, all scenarios in parallel. `--passes N`
// runs it N times and scores each count's median, so one pass that caught an
// extra event under load cannot decide a climb. `--runs N` adds N clean
// wall-clock passes after it (`--runs 0`: counts only, the fast loop).
// `--check` (at least two passes) fails if any count moved past the noise.
// `--why <scenario>` scores nothing: it runs one scenario on an unminified
// build and prints, for each restyle of 100+ elements and each layout over
// 1000+ objects, what invalidated it and the JS stack that did.
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
import { SCENARIOS, frame, settle } from './editor-bench/scenarios.mjs';
import {
  metrics,
  startCalls,
  startTrace,
  stopTrace,
  takeCalls,
  traceWork,
} from './editor-bench/trace.mjs';
import { whyReport } from './editor-bench/why.mjs';

const BUNDLE = path.resolve('build/native-editor/editor.html');
// `--why` drives an unminified copy so stacks carry real function names. It is
// for reading causes only and is never scored.
const WHY_OUT_DIR = 'build/native-editor-why';
let URL = `file://${BUNDLE}?test`;
// A phone-sized viewport: the embed is the mobile shells' editor.
const VIEWPORT = { width: 412, height: 915 };

const args = process.argv.slice(2);
const opt = {
  runs: 3,
  passes: 1,
  check: false,
  build: true,
  json: null,
  baseline: null,
  only: null,
  headed: false,
  why: null,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--runs') opt.runs = Number(args[++i]);
  else if (a === '--no-build') opt.build = false;
  else if (a === '--check') opt.check = true;
  else if (a === '--passes') opt.passes = Number(args[++i]);
  else if (a === '--json') opt.json = args[++i];
  else if (a === '--baseline') opt.baseline = args[++i];
  else if (a === '--only') opt.only = args[++i].split(',');
  else if (a === '--headed') opt.headed = true;
  else if (a === '--why') opt.why = args[++i];
  else {
    console.error(`Unrecognized argument: ${a}`);
    process.exit(2);
  }
}

async function runScenario(browser, scenario, instrument, why = false) {
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
  // CSS transitions run 100x fast (a 120 ms slide finishes in a frame or
  // two), so an animation counts as the elements it touches rather than as
  // however many frames the machine rendered during it: under load Chromium
  // renders fewer, and the drag scenarios' counts moved by a whole frame
  // (~50 elements) between passes. `transitionend` still fires, so the
  // gesture runs the same code path.
  const anim = await context.newCDPSession(page);
  await anim.send('Animation.enable');
  await anim.send('Animation.setPlaybackRate', { playbackRate: 100 });
  await scenario.setup(page);
  await settle(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (instrument) {
    await startCalls(cdp);
    await startTrace(cdp, why);
  }
  const before = await metrics(cdp);
  // Marks the start of the measured step in the trace (a TimeStamp event).
  await page.evaluate(() => console.timeStamp('editor-bench:run'));
  const tRun = performance.now();
  await scenario.run(page);
  const wallMs = performance.now() - tRun;
  await settle(page);
  const tSettled = performance.now();
  const after = await metrics(cdp);
  const events = instrument ? await stopTrace(cdp) : null;
  const work = instrument ? traceWork(events) : {};
  const jsCalls = instrument ? await takeCalls(cdp) : undefined;
  const tCollected = performance.now();

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
    events: why ? events : undefined,
    phaseMs: {
      load: tLoaded - t0,
      setup: tRun - tLoaded,
      run: wallMs,
      settle: tSettled - tRun - wallMs,
      collect: tCollected - tSettled,
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
// `--why` builds its own unminified copy; the regular bundle only has to exist,
// because the build config stages it into the native apps.
if (opt.build && !(opt.why && existsSync(BUNDLE))) {
  const t = performance.now();
  execFileSync(
    path.resolve('node_modules/.bin/vite'),
    ['build', '--config', 'vite.editor.config.ts', '--logLevel', 'error'],
    { stdio: 'inherit' },
  );
  buildMs = performance.now() - t;
}
if (!existsSync(BUNDLE)) throw new Error(`no bundle at ${BUNDLE}; run without --no-build`);

if (opt.why) {
  const scenario = SCENARIOS.find((s) => s.name === opt.why);
  if (!scenario) {
    console.error(`--why: no scenario "${opt.why}" (${SCENARIOS.map((s) => s.name).join(', ')})`);
    process.exit(2);
  }
  execFileSync(
    path.resolve('node_modules/.bin/vite'),
    [
      'build',
      '--config',
      'vite.editor.config.ts',
      '--logLevel',
      'error',
      '--minify',
      'false',
      '--outDir',
      WHY_OUT_DIR,
    ],
    { stdio: 'inherit' },
  );
  URL = `file://${path.resolve(WHY_OUT_DIR, 'editor.html')}?test`;
  const whyBrowser = await chromium.launch({ headless: !opt.headed });
  const r = await runScenario(whyBrowser, scenario, true, true);
  await whyBrowser.close();
  console.log(
    `${scenario.name}: ${scenario.note} (unminified bundle; times from the measured step's start)`,
  );
  whyReport(r.events);
  process.exit(0);
}

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
const passes = [];
for (let i = 0; i < Math.max(opt.passes, opt.check ? 2 : 1); i++) passes.push(await countPass());
const countsMs = performance.now() - tCounts;
// Near-exact rather than exact: the progressive open sizes its chunks by a
// time budget and timers fire a few more or fewer times, which moves a count
// by ~0.1 % at most (measured 2026-10-09). A real change is well above this.
// The drags add a fixed few: the 340 ms hold spans 20 or 21 frames, each
// restyling 4-5 elements, so drag-small (~470) moves by up to ~12. A drift
// fails only when it is past BOTH bounds. With 28 of 32 cores busy a drag
// can also catch one extra layout (drag-small layoutScope +10 %), which is
// what `--passes 3` and its median are for.
const NOISE_PCT = 0.5;
const NOISE_ABS = 24;
const COUNT_FIELDS = ['styledElements', 'layoutScope', 'jsCalls'];
let unstable = [];
let maxDriftPct = 0;
const counts = {};
for (const s of scenarios) {
  const runs = passes.map((p) => p[s.name]);
  counts[s.name] = { ...runs[0] };
  const hashes = new Set(runs.map((r) => r.hash));
  if (hashes.size > 1) unstable.push(`${s.name}.hash: ${[...hashes].join(' vs ')}`);
  for (const f of COUNT_FIELDS) {
    const xs = runs.map((r) => r[f]);
    counts[s.name][f] = median(xs);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const pct = hi === lo ? 0 : ((hi - lo) / hi) * 100;
    maxDriftPct = Math.max(maxDriftPct, pct);
    if (opt.check && pct > NOISE_PCT && hi - lo > NOISE_ABS)
      unstable.push(`${s.name}.${f}: ${xs.join(' vs ')} (${pct.toFixed(2)}%)`);
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
  `\ncounts: median of ${passes.length} instrumented pass(es); times: median of ${opt.runs} clean runs ±(max-min)/median\n`,
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
    `${passes.length > 1 ? ` (${passes.length} passes, median; max drift ${maxDriftPct.toFixed(3)}%)` : ''}, timing passes ${fmt(timingMs)} ms, total ${fmt(totalMs)} ms`,
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
