#!/usr/bin/env node
// Key → drawn frame on the text-first editor, over futo-notes-ml corpus notes,
// on an explicitly claimed physical phone. Installs the separate non-debuggable
// perf app (com.futo.notes.perf.dev), so the dev app and its data are untouched,
// runs TextFirstTypingBenchmarkTest, prints p50/p95 per note and action, then
// uninstalls. 16.7 ms is a diagnostic reference, not a performance gate.
//
//   ANDROID_SERIAL=… node scripts/android-text-first-bench.mjs [--random N] [--typed N]
//   ANDROID_SERIAL=… node scripts/android-text-first-bench.mjs --quick   (~8 notes, about a minute)
//   --profile N: simpleperf the app for the first N s of measuring; the trace
//   lands next to the report (`simpleperf report -i … --comms futo-editor`).
//   FUTO_NOTES_CORPUS overrides ../futo-notes-ml/dataset/notes_corpus.jsonl.gz
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'com.futo.notes.perf.dev';
const CLASS = 'com.futo.notes.textfirst.TextFirstTypingBenchmarkTest';
const BUDGET_MS = 16.7;
const PERF = '/data/local/tmp/tf-bench.perf';
// One note per measured problem shape (handoff §2) plus small typical notes.
// Labels come from selectNotes, so they stay stable while the corpus does.
const QUICK = [
  'most-lines-4b72d2', // 19,295 lines
  'longest-list-af5ebc', // 3,411-line nested list
  'biggest-table-06a6e2', // 30k-char table note
  'most-bytes-f76ca6', // 527 KB
  'longest-ordered-6ae4d2', // numbered list with nested items
  'random-882329', // 11k chars, slow on the Moto for no known reason
  'random-dbe64a',
  'random-c26119',
];

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
}

/** Deterministic PRNG so the random sample is the same every run. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function longestRun(body, pattern) {
  let best = 0;
  let run = 0;
  for (const line of body.split('\n')) {
    if (pattern.test(line)) best = Math.max(best, ++run);
    else if (line.trim() !== '') run = 0;
  }
  return best;
}

function longestFence(body) {
  let best = 0;
  let open = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      if (open === null) open = 0;
      else {
        best = Math.max(best, open);
        open = null;
      }
    } else if (open !== null) open++;
  }
  return best;
}

export function selectNotes(notes, randomCount) {
  const picks = new Map();
  const take = (label, key, count) => {
    for (const note of [...notes].sort((a, b) => key(b) - key(a)).slice(0, count))
      if (!picks.has(note.content_hash)) picks.set(note.content_hash, { label, note });
  };
  take('most-lines', (n) => n.body.split('\n').length, 3);
  take('most-bytes', (n) => Buffer.byteLength(n.body), 2);
  take('longest-list', (n) => longestRun(n.body, /^\s*[-*+]\s/), 2);
  take('longest-ordered', (n) => longestRun(n.body, /^\s*\d+[.)]\s/), 1);
  take('biggest-table', (n) => longestRun(n.body, /^\|.*\|\s*$/), 2);
  take('longest-fence', (n) => longestFence(n.body), 2);
  const random = mulberry32(283);
  const pool = notes.filter((n) => !picks.has(n.content_hash));
  for (let i = 0; i < randomCount && pool.length; i++) {
    const [note] = pool.splice(Math.floor(random() * pool.length), 1);
    picks.set(note.content_hash, { label: 'random', note });
  }
  return [...picks.values()];
}

/** Collection completeness is separate from performance; a slow valid run is evidence. */
export function validateCollection(report, manifest, baseline) {
  if (report.notes.length !== manifest.length) throw new Error('Missing fixture results');
  for (const [i, note] of report.notes.entries()) {
    if (note.label !== manifest[i].label) throw new Error('Fixture identity mismatch');
    if (note.error) throw new Error(`Fixture failed: ${note.label}`);
    const expected =
      baseline && manifest[i].cell ? ['type', 'backspace'] : ['type', 'enter', 'backspace'];
    if (JSON.stringify(note.actions?.map((a) => a.action)) !== JSON.stringify(expected))
      throw new Error('Missing action results');
    for (const action of note.actions) {
      if (
        action.timedOut ||
        action.refused ||
        !action.samples ||
        (baseline && action.samples !== action.requested)
      )
        throw new Error(`Incomplete trials: ${note.label}:${action.action}`);
    }
  }
}

function main() {
  const serial = process.env.ANDROID_SERIAL;
  // --allow-emulator: find which stage is slow; budgets are judged on a physical phone only.
  const allowEmulator =
    process.argv.includes('--allow-emulator') || process.argv.includes('--emulator');
  const quick = process.argv.includes('--quick');
  const began = Date.now();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(serial ?? '') ||
    (serial.startsWith('emulator-') && !allowEmulator)
  )
    throw new Error('Select an explicitly claimed physical Android phone (ANDROID_SERIAL)');
  const fixtureAt = process.argv.indexOf('--fixtures');
  const fixtureDir = fixtureAt < 0 ? null : path.resolve(process.argv[fixtureAt + 1]);
  let selected;
  if (fixtureDir) {
    const all = JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
    selected = all
      .filter((m) => (process.argv.includes('--stress') ? m.quantile === 100 : m.quantile < 100))
      .map((meta) => ({
        label: meta.label,
        meta,
        note: {
          body: readFileSync(path.join(fixtureDir, meta.file), 'utf8'),
          content_hash: meta.hash,
        },
      }));
  } else {
    const corpus =
      process.env.FUTO_NOTES_CORPUS ??
      path.resolve(ROOT, '../futo-notes-ml/dataset/notes_corpus.jsonl.gz');
    const notes = gunzipSync(readFileSync(corpus))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // --only a,b: just the notes whose label starts with one of these (e.g. most-lines-4b72d2).
    const onlyAt = process.argv.indexOf('--only');
    const only = onlyAt >= 0 ? process.argv[onlyAt + 1].split(',') : quick ? QUICK : null;
    selected = selectNotes(notes, arg('--random', 40)).filter(
      ({ label, note }) =>
        !only || only.some((o) => `${label}-${note.content_hash.slice(0, 6)}`.startsWith(o)),
    );
  }
  const filterAt = process.argv.indexOf('--only');
  if (fixtureDir && filterAt >= 0) {
    const prefixes = process.argv[filterAt + 1].split(',');
    selected = selected.filter((n) => prefixes.some((p) => n.label.startsWith(p)));
  }
  if (!selected.length) throw new Error('No benchmark fixtures selected');
  const out = mkdtempSync(path.join(tmpdir(), 'futo-text-first-bench-'));
  const run = (command, args, allowFailure = false) => {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 3_600_000,
    });
    if (!allowFailure && (result.error || result.status !== 0))
      throw (
        result.error ??
        new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
      );
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  };
  const adb = (...args) => run('adb', ['-s', serial, ...args]);
  const phases = [];
  const phase = (name, fn) => {
    const at = Date.now();
    try {
      return fn();
    } finally {
      phases.push(`${name} ${((Date.now() - at) / 1000).toFixed(1)} s`);
    }
  };
  const apks = 'apps/android/app/build/outputs/apk';
  const runId = randomUUID();
  run('just', ['qa-android-target']);
  const remote = `/sdcard/Android/data/${PACKAGE}/files`;
  try {
    writeFileSync(
      path.join(out, 'source.json'),
      JSON.stringify({
        head: run('git', ['rev-parse', 'HEAD']).trim(),
        status: run('git', ['status', '--short']),
        serial,
      }),
    );
    writeFileSync(path.join(out, 'source.patch'), run('git', ['diff', 'HEAD']));
    writeFileSync(
      path.join(out, 'apks.json'),
      JSON.stringify(
        [
          'direct/debug/app-direct-debug.apk',
          'androidTest/direct/debug/app-direct-debug-androidTest.apk',
        ].map((file) => ({
          file,
          sha256: createHash('sha256')
            .update(readFileSync(path.join(ROOT, apks, file)))
            .digest('hex'),
        })),
        null,
        2,
      ),
    );
    console.log(`Evidence: ${out}; measuring ${selected.length} fixtures`);
    phase('install', () => {
      adb('install', '-r', path.join(ROOT, apks, 'direct/debug/app-direct-debug.apk'));
      adb(
        'install',
        '-r',
        '-t',
        path.join(ROOT, apks, 'androidTest/direct/debug/app-direct-debug-androidTest.apk'),
      );
    });
    // A fresh adb install runs app code interpreted. Install the APK's
    // baseline profile and compile it, as a Play install would (~3 s).
    phase('compile', () => {
      adb(
        'shell',
        'am',
        'broadcast',
        '-a',
        'androidx.profileinstaller.action.INSTALL_PROFILE',
        `${PACKAGE}/androidx.profileinstaller.ProfileInstallReceiver`,
      );
      adb('shell', 'cmd', 'package', 'compile', '-m', 'speed-profile', '-f', PACKAGE);
      // The broadcast started a process; measure (and profile) a fresh one.
      adb('shell', 'am', 'force-stop', PACKAGE);
    });
    const bench = `/data/local/tmp/tf-bench-${runId}`;
    adb('shell', 'mkdir', '-p', bench);
    const manifest = phase('push', () =>
      selected.map(({ label, note, meta }, i) => {
        const file = `n${String(i).padStart(3, '0')}.md`;
        writeFileSync(path.join(out, file), note.body);
        adb('push', path.join(out, file), `${bench}/${file}`);
        return meta
          ? { ...meta, file }
          : { file, label: `${label}-${note.content_hash.slice(0, 6)}` };
      }),
    );
    writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest));
    if (fixtureDir && existsSync(path.join(fixtureDir, 'analysis.json')))
      writeFileSync(
        path.join(out, 'analysis.json'),
        readFileSync(path.join(fixtureDir, 'analysis.json')),
      );
    adb('push', path.join(out, 'manifest.json'), `${bench}/manifest.json`);
    const profileSeconds = arg('--profile', 0);
    // Detached on the phone: it waits for the measured process and writes
    // its trace on its own; adb returns at once.
    if (profileSeconds > 0)
      adb(
        'shell',
        `rm -f ${PERF}; nohup simpleperf record --app ${PACKAGE} -g --duration ${profileSeconds} -o ${PERF} >${PERF}.log 2>&1 &`,
      );
    const log = phase('measure', () =>
      adb(
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        '-e',
        'class',
        CLASS,
        '-e',
        'textFirstBenchDirectory',
        bench,
        ...(fixtureDir
          ? [
              '-e',
              'textFirstBenchBaseline',
              'true',
              '-e',
              'textFirstBenchKeys',
              String(arg('--keys', 50)),
              '-e',
              'textFirstBenchWarmup',
              '5',
            ]
          : []),
        '-e',
        'textFirstBench',
        'true',
        '-e',
        'textFirstBenchRunId',
        runId,
        '-e',
        'textFirstBenchTyped',
        String(arg('--typed', 100)),
        ...(quick && !fixtureDir
          ? [
              ...['-e', 'textFirstBenchKeys', String(arg('--keys', 30))],
              ...['-e', 'textFirstBenchSeriesBudgetMs', '3000'],
              ...['-e', 'textFirstBenchWarmup', '5'],
              ...['-e', 'textFirstBenchSettleMs', '16'],
            ]
          : []),
        `${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`,
      ),
    );
    writeFileSync(path.join(out, 'instrumentation.log'), log);
    const passed = /OK \(1 test\)/.test(log);
    if (profileSeconds > 0) {
      for (let i = 0; i < 60 && adb('shell', 'pidof simpleperf || true').trim(); i++)
        spawnSync('sleep', ['1']);
      adb('pull', PERF, path.join(out, 'perf.data'));
      adb('pull', `${PERF}.log`, path.join(out, 'profiler.log'));
    }
    // Results are written after every note, so a crash still leaves a partial report.
    const raw = run(
      'adb',
      ['-s', serial, 'exec-out', 'cat', `${remote}/text-first-bench-${runId}.json`],
      true,
    );
    if (!raw.trim().startsWith('{'))
      throw new Error(`benchmark failed with no report; see ${out}/instrumentation.log`);
    writeFileSync(path.join(out, 'report.json'), raw);
    const report = JSON.parse(raw);
    if (report.runId !== runId || report.debuggable !== false)
      throw new Error('report is not from this non-debuggable run');
    const ms = (ns) => (ns / 1e6).toFixed(1).padStart(6);
    console.log(
      `${report.model} (sdk ${report.sdk}), non-debuggable, accessibility ${report.accessibilityEnabled ? 'on' : 'off'}; key → drawn frame, diagnostic reference ${BUDGET_MS} ms`,
    );
    const pad = ' '.repeat(28 + 1 + 7 + 1 + 8);
    console.log(
      `${'note'.padEnd(28)} ${'chars'.padStart(7)} ${'open'.padStart(7)}  action      p50    p95    max  late p50/p95  on time  refused`,
    );
    let worst = 0;
    const errors = [];
    for (const note of report.notes) {
      if (note.error) {
        errors.push(note);
        console.log(`${note.label.padEnd(28)} FAILED: ${note.error.split('\n')[0]}`);
        continue;
      }
      note.actions.forEach((a, i) => {
        const head =
          i === 0
            ? `${note.label.padEnd(28)} ${String(note.chars).padStart(7)} ${ms(note.openNs)}ms`
            : pad;
        const refused = `${a.refused ?? 0}${a.timedOut ? ` +${a.timedOut} timed out` : ''}`;
        if (!a.samples) {
          console.log(`${head}  ${a.action.padEnd(9)} no drawn keys; refused ${refused}`);
          return;
        }
        worst = Math.max(worst, a.p95Ns);
        const late = a.framesLateP50 === undefined ? '' : `${a.framesLateP50}/${a.framesLateP95}`;
        console.log(
          `${head}  ${a.action.padEnd(9)} ${ms(a.p50Ns)} ${ms(a.p95Ns)} ${ms(a.maxNs)}  ${late.padStart(13)}  ${`${a.onTime ?? '?'}/${a.samples}`.padStart(7)}  ${refused}`,
        );
        if (a.stagesNs) {
          const st = a.stagesNs;
          const part = (k) => (st[k] === undefined ? '' : `${k} ${(st[k] / 1e6).toFixed(1)}`);
          console.log(
            `${pad}    p50 stages: ${['engine', 'kotlin', 'queue', 'text', 'spans', 'frameWait', 'draw'].map(part).join(' · ')}`,
          );
        }
      });
    }
    const failing = report.notes.flatMap((n) =>
      (n.actions ?? [])
        .filter((a) => !a.samples || a.p95Ns / 1e6 > BUDGET_MS)
        .map((a) => `${n.label}:${a.action}`),
    );
    console.log(
      `\nworst p95 ${ms(worst)} ms; ${failing.length} note/action pairs over diagnostic reference${failing.length ? `: ${failing.join(', ')}` : ''}`,
    );
    if (errors.length) console.log(`${errors.length} note(s) failed; stacks in ${out}/report.json`);
    console.log(
      `Evidence: ${out} (${((Date.now() - began) / 1000).toFixed(0)} s: ${phases.join(', ')})`,
    );
    validateCollection(report, manifest, Boolean(fixtureDir));
    if (!passed)
      throw new Error(`benchmark instrumentation failed; see ${out}/instrumentation.log`);
  } finally {
    run('adb', ['-s', serial, 'uninstall', `${PACKAGE}.test`], true);
    run('adb', ['-s', serial, 'uninstall', PACKAGE], true);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
