#!/usr/bin/env node
// How long leaving a note takes on iOS, from the Back tap to the list being
// back on screen — in the real app on a simulator, with real XCUITest taps.
//
//   node scripts/perf/ios-close-bench.mjs [--sim <udid>] [--sizes 1000,10000]
//       [--repeat 5] [--out <dir>] [--skip-build] [--skip-rust] [--label <name>]
//
// Runs on the Mac (xcodebuild, simctl). `--sim` defaults to $SIM, then the one
// booted simulator. Each run builds the editor bundle, regenerates the Xcode
// project and runs ONE UI test, `EditorClosePerfTests`
// (apps/ios/UITests/EditorClosePerfTests.swift), which seeds a note of each
// size into a throwaway vault under --out, opens it, optionally types one
// character, taps Back by coordinate and records the host wall clock at the
// tap (no accessibility query runs in the measured window). The app's
// debug-only CloseLedger (apps/ios/Sources/Notes/Editor/CloseLedger.swift)
// logs the phases in between on the same clock; this reads them back with
// `log show` and joins them to each sample.
//
// Output: a markdown table (median / p90 per size × clean|dirty) on stdout and
// `<out>/close-bench-<label>.json` with every sample.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PHASES = [
  'popObserved',
  'listFrame',
  'editorDisappeared',
  'bodyCurrent',
  'bodyClean',
  'bodyCommitted',
  'titleCommitted',
  'exitSettled',
];

function parseArgs(argv) {
  const opts = {
    sim: process.env.SIM || '',
    sizes: [1000, 10000],
    repeat: 5,
    out: path.join(root, 'apps/ios/.build/close-bench'),
    skipBuild: false,
    skipRust: false,
    label: new Date().toISOString().replace(/[:.]/g, '-'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--sim') opts.sim = next();
    else if (a === '--sizes') opts.sizes = next().split(',').map(Number);
    else if (a === '--repeat') opts.repeat = Number(next());
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--skip-rust') opts.skipRust = true;
    else if (a === '--label') opts.label = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.sim) {
    const booted = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.match(/\(([0-9A-F-]{36})\) \(Booted\)/i)?.[1])
      .filter(Boolean);
    if (booted.length !== 1) {
      throw new Error(
        `need exactly one booted simulator or --sim <udid>; booted: ${booted.join(', ') || 'none'}`,
      );
    }
    opts.sim = booted[0];
  }
  return opts;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

function build(opts) {
  if (!opts.skipRust) {
    run('bash', ['scripts/build-rust-ios.sh'], {
      env: {
        ...process.env,
        FUTO_IOS_FFI_PROFILE: process.env.FUTO_IOS_FFI_PROFILE || 'release-ffi',
      },
    });
  }
  run('node_modules/.bin/vite', ['build', '--config', 'vite.editor.config.ts']);
  run('xcodegen', ['generate'], { cwd: path.join(root, 'apps/ios') });
}

/** `log show` timestamps want local time without a zone. */
function localStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function readLedger(sim, since) {
  const text = execFileSync(
    'xcrun',
    [
      'simctl',
      'spawn',
      sim,
      'log',
      'show',
      '--start',
      localStamp(since),
      '--style',
      'compact',
      '--predicate',
      'subsystem == "com.futo.notes" AND category == "close-ledger"',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const marks = [];
  for (const line of text.split('\n')) {
    const m = line.match(/close (\w+) epochMs=(\d+) uptimeMs=(\d+) note=(.*)$/);
    if (m) marks.push({ phase: m[1], epochMs: Number(m[2]), note: m[4].trim() });
  }
  return marks;
}

/**
 * Every phase is measured from the app's own `touchUp` mark: the finger
 * lifting off Back, which is when a bar button fires. The test's clock reads
 * only bracket the tap (XCUITest spends 1-3 s inside `tap()` before it
 * synthesizes the touch), so they choose the window, never the origin.
 */
function joinSamples(samples, marks) {
  return samples.map((s) => {
    const touchUp = marks.find(
      (m) =>
        m.phase === 'touchUp' && m.epochMs >= s.tapEpochMs && m.epochMs <= s.tapReturnedEpochMs,
    );
    if (!touchUp) return { ...s, touchUp: null, phases: {} };
    const window = marks.filter(
      (m) => m.epochMs >= touchUp.epochMs && m.epochMs <= touchUp.epochMs + 5000,
    );
    const phases = {};
    for (const phase of PHASES) {
      const hit = window.find((m) => m.phase === phase);
      if (hit) phases[phase] = { ms: hit.epochMs - touchUp.epochMs, note: hit.note };
    }
    return { ...s, touchUp: { epochMs: touchUp.epochMs, note: touchUp.note }, phases };
  });
}

const quantile = (xs, q) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
};

function summarize(joined) {
  const cells = new Map();
  for (const s of joined) {
    const key = `${s.size}|${s.dirty}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(s);
  }
  const rows = [];
  for (const [key, list] of cells) {
    const [size, dirty] = key.split('|');
    const col = (pick) => {
      const xs = list.map(pick).filter((x) => typeof x === 'number');
      if (xs.length === 0) return '—';
      return `${quantile(xs, 0.5)} / ${quantile(xs, 0.9)}`;
    };
    rows.push({
      size: Number(size),
      dirty: dirty === 'true',
      n: list.length,
      popObserved: col((s) => s.phases.popObserved?.ms),
      listFrame: col((s) => s.phases.listFrame?.ms),
      editorDisappeared: col((s) => s.phases.editorDisappeared?.ms),
      bodyCurrent: col((s) => s.phases.bodyCurrent?.ms),
      bodyDone: col((s) => (s.phases.bodyCommitted ?? s.phases.bodyClean)?.ms),
      exitSettled: col((s) => s.phases.exitSettled?.ms),
      chain: col((s) =>
        s.phases.exitSettled && s.phases.editorDisappeared
          ? s.phases.exitSettled.ms - s.phases.editorDisappeared.ms
          : undefined,
      ),
    });
  }
  rows.sort((a, b) => a.size - b.size || Number(a.dirty) - Number(b.dirty));
  return rows;
}

function table(rows) {
  const head =
    '| note | edit | n | → popObserved | → listFrame | → editorDisappeared | → bodyCurrent | → body done | → exitSettled | commit chain after disappear |\n|---|---|---:|---|---|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.size} blocks | ${r.dirty ? 'dirty' : 'clean'} | ${r.n} | ${r.popObserved} | ${r.listFrame} | ${r.editorDisappeared} | ${r.bodyCurrent} | ${r.bodyDone} | ${r.exitSettled} | ${r.chain} |`,
    )
    .join('\n');
  return `${head}\n${body}\n\nCells are ms from the app's touchUp on Back, median / p90; the last column is exitSettled − editorDisappeared.`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.skipBuild) build(opts);
  mkdirSync(opts.out, { recursive: true });
  const resultsFile = path.join(opts.out, `samples-${opts.label}.jsonl`);
  const since = new Date(Date.now() - 5000);
  const config = JSON.stringify({ sizes: opts.sizes, repeat: opts.repeat });
  run(
    'xcodebuild',
    [
      'test',
      '-project',
      'apps/ios/FutoNotesNative.xcodeproj',
      '-scheme',
      'FutoNotesNative',
      '-destination',
      `id=${opts.sim}`,
      '-derivedDataPath',
      'apps/ios/.build',
      '-only-testing:FutoNotesNativeUITests/EditorClosePerfTests',
      'CODE_SIGNING_ALLOWED=YES',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=-',
    ],
    {
      env: {
        ...process.env,
        TEST_RUNNER_FUTO_CLOSE_PERF_CONFIG: config,
        TEST_RUNNER_FUTO_CLOSE_PERF_OUT: resultsFile,
      },
    },
  );
  if (!existsSync(resultsFile)) throw new Error(`the UI test wrote no samples to ${resultsFile}`);
  const samples = readFileSync(resultsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const expected = opts.sizes.length * 2 * opts.repeat;
  if (samples.length !== expected) {
    throw new Error(`expected ${expected} samples, the test produced ${samples.length}`);
  }
  const marks = readLedger(opts.sim, since);
  const joined = joinSamples(samples, marks);
  const missing = joined.filter(
    (s) =>
      !s.touchUp || !s.phases.popObserved || !s.phases.editorDisappeared || !s.phases.exitSettled,
  );
  // A "dirty" sample that logged bodyClean measured a clean close: the
  // edit never reached the editor, or the held save was not held.
  const notDirty = joined.filter((s) => s.dirty && !s.phases.bodyCommitted);
  const rows = summarize(joined);
  const report = {
    label: opts.label,
    sim: opts.sim,
    sizes: opts.sizes,
    repeat: opts.repeat,
    rows,
    samples: joined,
  };
  const reportFile = path.join(opts.out, `close-bench-${opts.label}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${joined.length} samples lack a touchUp/popObserved/editorDisappeared/exitSettled ledger mark — is this a Debug build with CloseLedger compiled in? (${reportFile})`,
    );
  }
  if (notDirty.length > 0) {
    throw new Error(
      `${notDirty.length} dirty samples committed no body — they measured a clean close (${reportFile})`,
    );
  }
  process.stdout.write(`${table(rows)}\n\nsamples: ${joined.length}, report: ${reportFile}\n`);
}

main();
