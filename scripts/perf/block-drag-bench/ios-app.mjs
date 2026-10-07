/*
 * `block-drag-bench.mjs --device ios-app`: the block drag in the REAL native iOS
 * app on a physical iPhone, driven by real touches from XCUITest.
 *
 * A network-paired phone has no usbmuxd entry, so the WebKit inspector is out of
 * reach; the measurement runs inside the page instead (ios-probe.js, started by
 * the DEBUG-only BlockDragBenchProbe.swift) and posts JSON lines into the dev
 * app's Documents, which this copies back with devicectl. XCUITest
 * (apps/ios/UITests/BlockDragBenchTests.swift) supplies the finger: the page shows
 * a one-line command, the test performs it, the page records frames while it does.
 *
 * Only the working tree's bundle is built and installed, so the variants are
 * `current` and `current:line` (the page flag, set by the probe); the CLI
 * rejects any other. A run is trusted only when `validateRecords` passes: the
 * test must exit 0, the probe must have posted `finished` with no `error`, and
 * every story must have produced its samples. Anything less throws.
 *
 * Runs in a throwaway vault of the DEV bundle (com.futo.notes.dev); never the
 * production app. Needs apps/ios/.signing-team (or FUTO_DEV_TEAM) and a
 * connected, unlocked, developer-mode device.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateNote } from './note.mjs';

const BUNDLE = 'com.futo.notes.dev';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

/** Writes the probe the UI test bundles, from ios-probe.js + the shared note generator. */
export function writeProbe(root, { sizes, repeat, selection, line }) {
  const config = { sizes, repeat, selection, line, bootWaitMs: 6000 };
  const gen = generateNote.toString();
  const out = [
    `const CONFIG = ${JSON.stringify(config)};`,
    gen,
    readFileSync(path.join(root, 'scripts/perf/block-drag-bench/ios-probe.js'), 'utf8'),
  ].join('\n');
  writeFileSync(path.join(root, 'apps/ios/UITests/BlockDragBenchProbe.js'), out);
}

export function runInIosApp(opts, { root, variant }) {
  const ios = path.join(root, 'apps/ios');
  const team =
    process.env.FUTO_DEV_TEAM ||
    (existsSync(path.join(ios, '.signing-team'))
      ? readFileSync(path.join(ios, '.signing-team'), 'utf8').trim()
      : '');
  if (!team) throw new Error('no signing team: set FUTO_DEV_TEAM or apps/ios/.signing-team');
  const udid =
    process.env.IOS_UDID ||
    sh('node', [path.join(root, 'scripts/ios-device-id.mjs')], { cwd: root }).trim();
  // Same dev id the xcodebuild destination wants (the CoreDevice id works for both).
  const plan = {
    sizes: opts.sizes,
    repeat: opts.repeat,
    selection: !opts.noSelection,
    line: variant.line,
  };
  writeProbe(root, plan);
  sh('bash', ['scripts/editor-deps.sh'], { cwd: root });
  sh('node_modules/.bin/vite', ['build', '--config', 'vite.editor.config.ts'], { cwd: root });
  sh('xcodegen', ['generate'], { cwd: ios });
  const results = mkdtempSync(path.join(tmpdir(), 'ios-bench-'));
  const xcresult = path.join(results, 'bench.xcresult');
  // A failing `xcodebuild test` (build, signing, the test's own XCTFail or its
  // deadline) throws out of here: partial results from a failed run are not data.
  try {
    sh(
      'xcodebuild',
      [
        'test',
        '-project',
        'FutoNotesNative.xcodeproj',
        '-scheme',
        'FutoNotesNative',
        '-configuration',
        'Debug',
        '-destination',
        `id=${udid}`,
        '-derivedDataPath',
        '.build-device',
        '-only-testing:FutoNotesNativeUITests/BlockDragBenchTests',
        '-resultBundlePath',
        xcresult,
        `DEVELOPMENT_TEAM=${team}`,
        'CODE_SIGN_STYLE=Automatic',
        'CODE_SIGNING_ALLOWED=YES',
        'CODE_SIGNING_REQUIRED=YES',
        'CODE_SIGN_IDENTITY=Apple Development',
        '-allowProvisioningUpdates',
      ],
      { cwd: ios, stdio: ['ignore', 'inherit', 'inherit'] },
    );
  } catch (e) {
    throw new Error(`xcodebuild test failed (${e.message}); xcresult at ${xcresult}`, { cause: e });
  }
  const local = path.join(results, 'futo-bench-results.jsonl');
  sh('xcrun', [
    'devicectl',
    'device',
    'copy',
    'from',
    '--device',
    udid,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE,
    '--source',
    'Documents/futo-bench-results.jsonl',
    '--destination',
    local,
  ]);
  const records = readFileSync(local, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${local}:${i + 1}: not JSON: ${l.slice(0, 120)}`);
      }
    });
  console.error('results:', local, ' xcresult:', xcresult);
  validateRecords(records, plan);
  logExtras(records);
  return toRuns(records);
}

const KINDS = ['arm-sync', 'lift', 'edge', 'scroll-arm'];
const SELECTIONS = ['strong', 'em', 'link', 'plain'];

/** Throws, listing every problem, unless `records` (the probe's JSON lines) are
 * a complete, healthy run of `plan`: one `hello`, a closing `finished`, no
 * `error`, `repeat` records of each story per size, real lifts and auto-scrolls,
 * the preview the variant asked for, and the selection stories when planned. */
export function validateRecords(records, plan) {
  const problems = [];
  for (const r of records.filter((x) => x.kind === 'error'))
    problems.push(`probe error: ${r.message ?? JSON.stringify(r)}`);
  if (records.filter((x) => x.kind === 'hello').length !== 1)
    problems.push('want exactly one hello');
  const finished = records.filter((x) => x.kind === 'finished').length;
  if (finished !== 1 || records.at(-1)?.kind !== 'finished')
    problems.push(
      `run did not finish (${finished} finished records, last is ${records.at(-1)?.kind})`,
    );
  const want = plan.line ? 'line' : 'reflow';
  for (const blocks of plan.sizes) {
    for (const kind of KINDS) {
      const got = records.filter((r) => r.kind === kind && r.blocks === blocks);
      if (got.length !== plan.repeat)
        problems.push(`${blocks} blocks: ${got.length} ${kind} records, want ${plan.repeat}`);
    }
    const at = (kind) => records.filter((r) => r.kind === kind && r.blocks === blocks);
    for (const r of at('lift')) {
      const tag = `${blocks} blocks rep ${r.rep} lift`;
      if (r.liftedAfterMs == null) problems.push(`${tag}: the block never lifted`);
      if (!(r.moves > 0)) problems.push(`${tag}: no touchmoves after the lift`);
      if (!r.dragSamples?.length) problems.push(`${tag}: no drag frames`);
      if (r.liftFrame == null) problems.push(`${tag}: no lift frame`);
      if (r.dropFrame == null) problems.push(`${tag}: no drop frame`);
      if (r.mode !== want)
        problems.push(`${tag}: preview was ${r.mode}, variant asked for ${want}`);
    }
    for (const r of at('edge')) {
      const tag = `${blocks} blocks rep ${r.rep} edge`;
      if (!(r.scrolledPx > 0)) problems.push(`${tag}: the hold at the edge never auto-scrolled`);
      if (!r.scrollSamples?.length) problems.push(`${tag}: no auto-scroll frames`);
    }
    for (const r of at('scroll-arm')) {
      const tag = `${blocks} blocks rep ${r.rep} scroll`;
      if (!r.scrollWindow || r.armWindowFrame == null) problems.push(`${tag}: no scroll frames`);
    }
  }
  const sel = records.filter((r) => r.kind === 'selection');
  const taps = records.filter((r) => r.kind === 'tap');
  if (plan.selection) {
    for (const name of SELECTIONS)
      if (sel.filter((r) => r.name === name && !r.error).length !== 1)
        problems.push(`selection: want one clean ${name} record`);
    if (sel.length !== SELECTIONS.length || sel.some((r) => r.error))
      problems.push(`selection: ${sel.length} records, some with errors`);
    if (taps.length !== 1) problems.push(`selection: ${taps.length} tap records, want 1`);
  } else if (sel.length || taps.length) {
    problems.push('selection stories ran but were not planned');
  }
  if (problems.length)
    throw new Error(`the iOS bench run is not valid:\n- ${problems.join('\n- ')}`);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const one = (ms) => ({ reps: 1, totalMs: ms, samplesMs: [ms] });
const many = (xs) => ({ reps: xs.length, totalMs: sum(xs), samplesMs: xs });

/** The records of a validated run, shaped like app-device.mjs's runs so the
 * CLI's report prints them: one run per (size, rep). */
export function toRuns(records) {
  return records
    .filter((r) => r.kind === 'lift')
    .map((lift) => {
      const edge = records.find(
        (r) => r.kind === 'edge' && r.blocks === lift.blocks && r.rep === lift.rep,
      );
      return {
        blocks: lift.blocks,
        mode: lift.mode,
        leftover: lift.leftover,
        scroller: `vsync ${lift.vsync.toFixed(1)}ms, auto-scrolled ${edge.scrolledPx}px`,
        result: {
          'lift frame': one(lift.liftFrame),
          'gap frame': many(lift.dragSamples),
          'scroll frame': many(edge.scrollSamples),
          'drop frame': one(lift.dropFrame),
        },
      };
    });
}

/** The stories the shared report has no row for, as one line each on stderr. */
function logExtras(records) {
  for (const r of records) {
    if (r.kind === 'scroll-arm')
      console.error(
        `scroll-arm ${r.blocks} #${r.rep}: arm window max ${r.armWindowFrame.toFixed(1)}ms, scroll p95 ${r.scrollWindow.p95.toFixed(1)}ms, after-end max ${r.afterEndFrame?.toFixed?.(1)}ms`,
      );
    else if (r.kind === 'arm-sync')
      console.error(
        `arm-sync ${r.blocks} #${r.rep}: arm med ${r.arm.med.toFixed(1)}ms, disarm med ${r.disarm.med.toFixed(1)}ms`,
      );
    else if (r.kind === 'selection' || r.kind === 'tap') console.error(JSON.stringify(r));
  }
}
