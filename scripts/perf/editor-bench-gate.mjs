#!/usr/bin/env node
// The hill-climb gate: one command that says ACCEPT or REJECT for the working
// tree's editor against the bench baseline, so an agent climbing
// `just bench-editor` cannot bank noise, a regression, or a behavior change.
//
//   node --experimental-strip-types scripts/perf/editor-bench-gate.mjs [--accept]
//       [--baseline <file>] [--workers N] [--min-win 0.5] [--skip-suite]
//       [--regression-only]
//
// In order, cheapest first, stopping at the first REJECT:
//   1. The bench, rebuilt, 3 count passes, median (`editor-bench.mjs`). Any
//      final-markdown hash that changed is a behavior change: REJECT.
//   2. Score: the mean over scenarios and counts of current/baseline must be at
//      least --min-win percent below 1 (default 0.5 %, past the bench's noise).
//   3. No single count may get worse past the noise (0.5 % and 24): a win in
//      one scenario cannot pay for a regression in another.
//   4. The editor-embed Playwright suite (~700 behavior tests on the same
//      editor.html). The hash only guards the markdown; this is what catches a
//      broken caret, scroll, find, drag or bridge message. A failure not listed
//      in editor-bench-gate-known-failures.json: REJECT.
//
// ACCEPT exits 0, and with --accept writes the new counts as the baseline.
// REJECT exits 1. A crash or bad argument exits 2.
// `--skip-suite` stops after step 3 and never accepts: it is for triage.
// `--regression-only` is the CI mode (bench:editor): steps 1 and 3 only, so a
// change that is not a win still passes, and the suite is left to its own
// job. It ACCEPTs without ever writing the baseline (--accept is refused).

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { playwrightArtifacts } from '../playwright-artifacts.mjs';

const BENCH = 'scripts/perf/editor-bench.mjs';
const KNOWN_FAILURES = 'scripts/perf/editor-bench-gate-known-failures.json';
const SUITE_RESULTS = playwrightArtifacts('editor-embed', 'editor-embed-results.json').jsonReport;
// The bench's own noise bounds (editor-bench.mjs): a drift counts only past both.
const NOISE_PCT = 0.5;
const NOISE_ABS = 24;
const COUNTS = ['styledElements', 'layoutScope', 'jsCalls'];

const args = process.argv.slice(2);
const opt = {
  accept: false,
  baseline: 'docs/perf/editor-bench-baseline.json',
  workers: 16,
  minWin: 0.5,
  suite: true,
  regressionOnly: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--accept') opt.accept = true;
  else if (a === '--baseline') opt.baseline = args[++i];
  else if (a === '--workers') opt.workers = Number(args[++i]);
  else if (a === '--min-win') opt.minWin = Number(args[++i]);
  else if (a === '--skip-suite') opt.suite = false;
  else if (a === '--regression-only') opt.regressionOnly = true;
  else {
    console.error(`Unrecognized argument: ${a}`);
    process.exit(2);
  }
}

if (opt.regressionOnly && opt.accept) {
  console.error('--regression-only never writes the baseline; drop --accept');
  process.exit(2);
}

const t0 = performance.now();
const secs = () => `${((performance.now() - t0) / 1000).toFixed(0)}s`;
function verdict(word, lines) {
  console.log(`\n${word} (${secs()})`);
  for (const l of lines) console.log(`  ${l}`);
  process.exit(word === 'ACCEPT' ? 0 : 1);
}

// ── 1. The bench ─────────────────────────────────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), 'editor-bench-gate-'));
const current = path.join(dir, 'current.json');
console.log(`[gate] bench: build + 3 count passes against ${opt.baseline}`);
const bench = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    BENCH,
    '--runs',
    '0',
    '--passes',
    '3',
    '--baseline',
    opt.baseline,
    '--json',
    current,
  ],
  { encoding: 'utf8' },
);
process.stdout.write(bench.stdout);
process.stderr.write(bench.stderr);
if (bench.status !== 0) {
  const fails = `${bench.stdout}\n${bench.stderr}`.split('\n').filter((l) => l.startsWith('FAIL'));
  rmSync(dir, { recursive: true, force: true });
  if (fails.length === 0) {
    console.error('[gate] the bench crashed; see its output above');
    process.exit(2);
  }
  verdict('REJECT', [
    'the bench failed — the saved markdown changed, or differed between passes:',
    ...fails,
  ]);
}

// ── 2 + 3. Score and per-count regressions ───────────────────────────────
const base = JSON.parse(readFileSync(opt.baseline, 'utf8')).summary;
const now = JSON.parse(readFileSync(current, 'utf8')).summary;
const ratios = [];
const regressions = [];
const wins = [];
for (const [name, s] of Object.entries(now)) {
  const b = base[name];
  if (!b) continue;
  for (const f of COUNTS) {
    const was = b[f].median;
    const is = s[f].median;
    if (was > 0) ratios.push(is / was);
    const pct = was === 0 ? (is === 0 ? 0 : 100) : ((is - was) / was) * 100;
    const line = `${name}.${f} ${was} → ${is} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    if (pct > NOISE_PCT && is - was > NOISE_ABS) regressions.push(line);
    else if (-pct > NOISE_PCT && was - is > NOISE_ABS) wins.push(line);
  }
}
const missing = Object.keys(base).filter((n) => !(n in now));
if (missing.length) {
  rmSync(dir, { recursive: true, force: true });
  verdict('REJECT', [`scenarios missing from the run: ${missing.join(', ')}`]);
}
const score = ratios.reduce((a, r) => a + r, 0) / ratios.length;
const scoreLine = `score ${score.toFixed(4)} (1.0000 = baseline; a win needs ≤ ${(1 - opt.minWin / 100).toFixed(4)})`;
if (regressions.length) {
  rmSync(dir, { recursive: true, force: true });
  verdict('REJECT', [scoreLine, 'counts that got worse past the noise:', ...regressions]);
}
if (opt.regressionOnly) {
  rmSync(dir, { recursive: true, force: true });
  verdict('ACCEPT', [scoreLine, 'regression-only: no count got worse past the noise']);
}
if (score > 1 - opt.minWin / 100) {
  rmSync(dir, { recursive: true, force: true });
  verdict('REJECT', [scoreLine, 'not a win: within the noise of the baseline']);
}
console.log(`\n[gate] ${scoreLine}`);
for (const w of wins) console.log(`[gate]   ${w}`);

// ── 4. Behavior: the editor-embed suite ──────────────────────────────────
// Fully parallel on 16 workers: ~80 s instead of 10 min on the config's one
// worker. At that load about one timing-sensitive test fails per run, a
// different one each time (measured 2026-10-09), so failures are re-run once
// on ONE worker, the suite's own configuration: a test that passes there is
// reported as flaky under load and does not block; one that fails again does.
if (!opt.suite) {
  rmSync(dir, { recursive: true, force: true });
  verdict('REJECT', [scoreLine, 'counts pass; --skip-suite never accepts — run without it']);
}

function runSuite(extra) {
  // Only a report produced by this invocation can justify accepting its result.
  rmSync(SUITE_RESULTS, { force: true });
  const run = spawnSync('pnpm', ['run', 'test:e2e:editor-embed', ...extra], {
    encoding: 'utf8',
  });
  const tail = run.stdout
    .split('\n')
    .filter((l) => /^\s+\d+\) |\d+ (passed|failed|flaky|skipped)/.test(l));
  for (const l of tail) console.log(`[gate] ${l.trim()}`);
  let report;
  try {
    report = JSON.parse(readFileSync(SUITE_RESULTS, 'utf8'));
  } catch {
    rmSync(dir, { recursive: true, force: true });
    console.error(`[gate] the suite left no ${SUITE_RESULTS}; it crashed:\n${run.stderr}`);
    process.exit(2);
  }
  const failed = [];
  let ran = 0;
  const walk = (node, titles) => {
    for (const spec of node.specs ?? [])
      for (const t of spec.tests) {
        ran += 1;
        if (t.status === 'unexpected' || t.status === 'flaky')
          failed.push(`${spec.file} › ${[...titles, spec.title].join(' › ')}`);
      }
    for (const child of node.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const r of report.suites) walk(r, []);
  return { ran, failed };
}

console.log(`\n[gate] editor-embed suite, ${opt.workers} workers, fully parallel`);
const first = runSuite([`--workers=${opt.workers}`, '--fully-parallel']);
// M11: a suite that ran nothing is not a pass.
if (first.ran < 650) {
  rmSync(dir, { recursive: true, force: true });
  console.error(
    `[gate] the suite reported only ${first.ran} tests (expected ~709); not trusting it`,
  );
  process.exit(2);
}
const known = new Set(JSON.parse(readFileSync(KNOWN_FAILURES, 'utf8')).failures.map((f) => f.test));
let suspects = first.failed.filter((f) => !known.has(f));
let flaky = [];
if (suspects.length) {
  console.log(`\n[gate] re-running ${first.failed.length} failure(s) on one worker`);
  const again = runSuite(['--last-failed', '--workers=1']);
  flaky = suspects.filter((f) => !again.failed.includes(f));
  suspects = suspects.filter((f) => again.failed.includes(f));
}
const nowPassing = [...known].filter((k) => !first.failed.includes(k));
if (suspects.length) {
  rmSync(dir, { recursive: true, force: true });
  verdict('REJECT', [
    scoreLine,
    `${suspects.length} editor-embed test(s) failing, on 16 workers and again on one:`,
    ...suspects,
  ]);
}

const notes = [scoreLine, `editor-embed: ${first.ran} tests, nothing newly failing`];
if (flaky.length)
  notes.push('failed under parallel load, passed on one worker (not blocking):', ...flaky);
if (nowPassing.length)
  notes.push(`known failures now passing (remove them from ${KNOWN_FAILURES}):`, ...nowPassing);
if (opt.accept) {
  copyFileSync(current, opt.baseline);
  notes.push(`baseline updated: ${opt.baseline} — commit it with the change`);
} else notes.push('re-run with --accept to make this the new baseline');
rmSync(dir, { recursive: true, force: true });
verdict('ACCEPT', notes);
