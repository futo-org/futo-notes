#!/usr/bin/env node
// Real keyboard -> native Rust editor -> presented Android frames, on the
// claimed Moto reference phone. Builds a non-debuggable DEV app; never clears
// data. Seeds only a unique test folder in a verified DEVICE-mode dev vault.
// A single shell app_process replays touches through InputManager, preserving
// normal input boosting without starting a Java process per key. Navigation
// retains the app's animations. No instrumentation or accessibility service.
// Perfetto records only FrameTimeline/process metadata. Detailed sched/gfx
// tracing measurably perturbs keyboard rendering on this phone.
//
// just test-android-real-input [--reuse] [--only paragraph|typing|navigation]
// --reuse verifies the installed APK against this checkout's non-debuggable
// APK. It is for the tight edit/build/measure loop, not permission to use a
// stale build. Evidence and test fixtures are retained, including on failure.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  encodePlan,
  failures,
  fixtures as builtinFixtures,
  frameSummary,
  latencyWindows,
  navigationTrials,
  typingPlan,
} from './android-real-input/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = 'com.futo.notes.dev';
const args = process.argv.slice(2);
const fixtureFile = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const findCell = args.includes('--find-cell') ? args[args.indexOf('--find-cell') + 1] : null;
if (Boolean(fixtureFile) !== Boolean(findCell))
  throw new Error('--fixture and --find-cell must be supplied together');
const fixtures = fixtureFile
  ? { corpus: readFileSync(path.resolve(fixtureFile), 'utf8') }
  : builtinFixtures;
const only = args.includes('--only')
  ? args[args.indexOf('--only') + 1]
  : fixtureFile
    ? 'typing'
    : 'all';
if (fixtureFile && only !== 'typing')
  throw new Error('A corpus cell fixture supports --only typing');
const cycles = args.includes('--cycles') ? Number(args[args.indexOf('--cycles') + 1]) : 3;
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10)
  throw new Error('--cycles must be 1..10');
if (!['all', 'paragraph', 'typing', 'navigation'].includes(only))
  throw new Error('Unknown --only story');
const serial = process.env.ANDROID_SERIAL;
if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(serial ?? '') || serial.startsWith('emulator-'))
  throw new Error('ANDROID_SERIAL must name the claimed physical phone');
const id = randomUUID();
const out = path.join(root, '.futo/runs', `android-real-input-${id}`);
mkdirSync(out, { recursive: true });
console.log(`Evidence: ${out}`);
let command = 0;
function run(executable, argv, visible = false, env = process.env) {
  const r = spawnSync(executable, argv, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 32e6,
  });
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(
    path.join(out, `${++command}.log`),
    `${JSON.stringify([executable, ...argv])}\n${output}`,
  );
  if (visible) process.stdout.write(output);
  if (r.error || r.status !== 0)
    throw r.error ?? new Error(`${executable} exited ${r.status}: ${output.slice(-3000)}`);
  return r.stdout;
}
const adb = (...argv) => run('adb', ['-s', serial, ...argv]);
const puppet = (...argv) =>
  run('just', ['puppet', ...argv], true, { ...process.env, FUTO_PUPPET_TARGET: 'android' });
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

run('just', ['qa-android-target'], true);
if (!args.includes('--reuse'))
  run('just', ['android-native'], true, {
    ...process.env,
    ORG_GRADLE_PROJECT_futoDebuggable: 'false',
    ORG_GRADLE_PROJECT_futoOptimize: args.includes('--unoptimized') ? 'false' : 'true',
  });
run('just', ['qa-android-apk'], true);
if (adb('shell', 'dumpsys', 'package', pkg).match(/pkgFlags=\[[^\]]*DEBUGGABLE/))
  throw new Error('Performance verdicts require a non-debuggable app');
const ime = adb('shell', 'settings', 'get', 'secure', 'default_input_method').trim();
const keyboardPkg = ime.split('/')[0];
if (
  adb('shell', 'getprop', 'ro.product.model').trim() !== 'moto g play - 2023' ||
  adb('shell', 'wm', 'size').trim() !== 'Physical size: 720x1600' ||
  ![
    'org.futo.inputmethod.latin/.LatinIME',
    'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
  ].includes(ime) ||
  Number(adb('shell', 'settings', 'get', 'system', 'font_scale')) !== 1
)
  throw new Error(
    'This keyboard touch map requires the Moto reference phone, 720x1600, normal font scale and a verified FUTO/Gboard layout; add a verified map for a different keyboard',
  );
const apk = path.join(root, 'apps/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk');
const dex = spawnSync('unzip', ['-p', apk, 'classes.dex'], { maxBuffer: 128e6 });
if (dex.error || dex.status !== 0)
  throw dex.error ?? new Error('Cannot read APK optimization marker');
const optimized = dex.stdout.includes(Buffer.from('~~R8{'));
if (optimized === args.includes('--unoptimized'))
  throw new Error(
    'APK optimization differs from requested mode; rebuild or use --unoptimized for the explicit debug control',
  );
copyFileSync(apk, path.join(out, 'tested.apk'));
writeFileSync(path.join(out, 'source.patch'), run('git', ['diff', '--binary', 'HEAD']));
const sdk =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  readFileSync(path.join(root, 'apps/android/local.properties'), 'utf8').match(
    /^sdk.dir=(.+)$/m,
  )?.[1];
const buildTools = path.join(sdk, 'build-tools');
const version = readdirSync(buildTools)
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const androidJar = path.join(sdk, 'platforms/android-36/android.jar');
const tpDir = path.join(os.homedir(), '.local/share/perfetto/prebuilts');
const tp =
  process.env.PERFETTO_TRACE_PROCESSOR ??
  (existsSync(tpDir) &&
    readdirSync(tpDir)
      .filter((s) => s.startsWith('trace_processor_shell-'))
      .map((s) => path.join(tpDir, s))[0]);
if (!tp)
  throw new Error('Set PERFETTO_TRACE_PROCESSOR to the installed Perfetto trace_processor_shell');
const remote = `/data/local/tmp/moto-real-input-${id}`;
adb('shell', 'mkdir', '-p', remote);
run('javac', ['-cp', androidJar, '-d', out, 'scripts/perf/android-real-input/PerfInput.java']);
run(path.join(buildTools, version, 'd8'), [
  '--lib',
  androidJar,
  '--output',
  out,
  path.join(out, 'PerfInput.class'),
]);
adb('push', path.join(out, 'classes.dex'), `${remote}/classes.dex`);

function query(trace, sql) {
  const output = run(tp, ['query', '--no-agent', '--format', 'csv', trace, sql]);
  // One SQLite-generated JSON cell, emitted as CSV. This is not a CSV parser
  // for arbitrary rows: require exactly the header and that one quoted cell.
  const lines = output.trim().split('\n');
  if (lines.length !== 2 || !lines[1].startsWith('"') || !lines[1].endsWith('"'))
    throw new Error(`Unexpected trace query output: ${output.slice(0, 500)}`);
  return JSON.parse(lines[1].slice(1, -1).replaceAll('""', '"'));
}
// A dropped surface frame may have no corresponding presented display frame.
// Keep it in the result; an inner join would silently erase exactly that failure.
const framesSql = `select json_group_array(json_object('owner',p.name,'ts',a.ts,
 'presentNs',case when a.present_type != 'Dropped Frame' and sf.dur>0 then sf.ts+sf.dur else null end,
 'presentType',a.present_type,'jank',a.jank_type,'displayJank',sf.jank_type)) result
 from actual_frame_timeline_slice a join process p on p.upid=a.upid
 left join actual_frame_timeline_slice sf on sf.display_frame_token=a.display_frame_token
   and sf.upid in (select upid from process where name='/system/bin/surfaceflinger')
 where p.name in ('${pkg}','${keyboardPkg}') and a.dur>0`;

async function capture(name, plan) {
  run('just', ['qa-android-target']);
  const duration = plan.at(-1).time + 3500;
  const localPlan = path.join(out, `${name}.plan`);
  writeFileSync(localPlan, encodePlan(plan));
  adb('push', localPlan, `${remote}/${name}.plan`);
  const config = `buffers { size_kb: 16384 fill_policy: RING_BUFFER }
data_sources { config { name: "android.surfaceflinger.frametimeline" } }
data_sources { config { name: "linux.process_stats" process_stats_config { scan_all_processes_on_start: true } } }
duration_ms: ${duration}\n`;
  writeFileSync(path.join(out, `${name}.pbtx`), config);
  const traceLog = openSync(path.join(out, `${name}-perfetto.log`), 'w');
  const recorder = spawn(
    'adb',
    [
      '-s',
      serial,
      'shell',
      'perfetto',
      '--txt',
      '-c',
      '-',
      '-o',
      `/data/misc/perfetto-traces/moto-${id}-${name}.pftrace`,
    ],
    { stdio: ['pipe', traceLog, traceLog] },
  );
  const completed = new Promise((resolve, reject) => {
    recorder.on('error', reject);
    recorder.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`perfetto exited ${code}`)),
    );
  });
  recorder.stdin.end(config);
  // Do not block Node in a synchronous adb replay until the child has actually
  // connected. Otherwise pipe/startup work can wait until AFTER typing and
  // produce a perfectly healthy trace of an idle editor instead.
  const readyBy = Date.now() + 10000;
  while (
    !readFileSync(path.join(out, `${name}-perfetto.log`), 'utf8').includes(
      'Connected to the Perfetto',
    )
  ) {
    if (Date.now() > readyBy) throw new Error('Perfetto did not connect before input');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  adb('shell', 'log', '-t', 'FutoRealInput', `${id}-${name}-begin`);
  console.log(`Measuring ${name}: ${plan.length} real touches, ${(duration / 1000).toFixed(1)}s`);
  const output = adb(
    'shell',
    `CLASSPATH=${remote}/classes.dex app_process /system/bin PerfInput ${remote}/${name}.plan`,
  );
  writeFileSync(path.join(out, `${name}-input.log`), output);
  const events = output
    .trim()
    .split('\n')
    .map((line) => {
      const [label, uptime, down, up] = line.trim().split(/\s+/);
      if (![uptime, down, up].every((n) => Number.isFinite(Number(n))))
        throw new Error(`Invalid input receipt: ${line}`);
      return { label, downNs: +down, upNs: +up };
    });
  if (events.length !== plan.length || events.some((e, i) => e.label !== plan[i].label))
    throw new Error('Missing input receipts');
  await completed;
  const trace = path.join(out, `${name}.pftrace`);
  adb('pull', `/data/misc/perfetto-traces/moto-${id}-${name}.pftrace`, trace);
  const allFrames = query(trace, framesSql);
  const frames = allFrames.filter((f) => f.owner === pkg);
  const keyboardFrames = allFrames.filter((f) => f.owner === keyboardPkg);
  if (frames.some((f) => f.presentType !== 'Dropped Frame' && f.presentNs === null))
    throw new Error('App frames are missing presentation evidence');
  if (!frames.length) throw new Error(`No FrameTimeline data for ${name}`);
  if (
    Math.min(...frames.map((f) => f.ts)) > events[0].downNs + 1e9 ||
    Math.max(...frames.map((f) => f.presentNs)) < events.at(-1).upNs
  )
    throw new Error('FrameTimeline does not cover the input replay');
  const health = query(
    trace,
    `select json_group_array(json_object('name',name,'value',value)) result from stats where severity='error' and value>0`,
  );
  // Preserve trace health. Negative process metadata timestamps on this vendor
  // can occur; lost frame/protobuf events are not an acceptable green result.
  if (health.some((s) => s.name !== 'trace_sorter_negative_timestamp_dropped'))
    throw new Error(`Trace import errors: ${JSON.stringify(health)}`);
  const logs = adb('logcat', '-d', '-s', 'FutoRealInput:I', 'TextFirstLatency:I');
  const marker = `${id}-${name}-begin`;
  if (!logs.includes(marker)) throw new Error('Latency log marker was lost');
  const current = logs.slice(logs.lastIndexOf(marker) + marker.length);
  writeFileSync(path.join(out, `${name}-latency.log`), current);
  return { frames, keyboardFrames, events, health, windows: latencyWindows(current) };
}

puppet('relaunch');
const state = JSON.parse(run('just', ['android-drive', 'state']));
if (state.storageMode !== 'DEVICE' || !state.vaultPath.endsWith('/FUTO Notes Dev'))
  throw new Error('Fixture seeding requires the isolated DEVICE-mode dev vault');
// A short title avoids measuring artificial UUID wrapping in the folder bar.
// Exclusive mkdir refuses a collision rather than overwriting an earlier run.
const folder = `000-moto-${id.slice(0, 8)}`;
const localFixtures = path.join(out, 'fixtures');
mkdirSync(localFixtures);
for (const [name, body] of Object.entries(fixtures))
  writeFileSync(path.join(localFixtures, `${name}.md`), body);
adb('shell', `mkdir ${shellQuote(`${state.vaultPath}/${folder}`)}`);
for (const name of Object.keys(fixtures))
  adb('push', path.join(localFixtures, `${name}.md`), `${state.vaultPath}/${folder}/${name}.md`);
puppet('relaunch');
puppet('do', 'ScrollToRow', JSON.stringify({ path: folder }));
puppet('do', 'OpenFolder', JSON.stringify({ path: folder }));
const memory = adb('shell', 'dumpsys', 'meminfo', pkg);
writeFileSync(path.join(out, 'meminfo.txt'), memory);
if (!/WebViews:\s+0\b/.test(memory))
  throw new Error('Native editor benchmark must not create a WebView');
const report = {
  formatVersion: 2,
  optimized,
  ime,
  runId: id,
  serial,
  source: run('git', ['rev-parse', 'HEAD']).trim(),
  dirty: run('git', ['status', '--short']),
  apkSha256: createHash('sha256')
    .update(
      readFileSync(
        path.join(root, 'apps/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk'),
      ),
    )
    .digest('hex'),
  dexopt: adb('shell', 'dumpsys', 'package', pkg)
    .split('Dexopt state:')[1]
    ?.split('Compiler stats:')[0],
  folder,
  corpusCell: fixtureFile ? { file: path.resolve(fixtureFile), query: findCell } : null,
  acceptancePolicy:
    'Diagnostic only: collection integrity is checked; performance thresholds are not calibrated.',
  limitations: [
    'Verified Moto/FUTO and Moto/Gboard keyboard touch maps only; the runner refuses other layouts.',
    'Idle flushes retain partial latency windows; first/final input coverage is checked. No-op keys need not draw.',
    'Navigation measures tap-to-settled presentation including the existing animation, not first readable content.',
    'Input-to-draw excludes GPU/display latency; FrameTimeline checks presentation deadlines separately.',
    'This is an opt-in physical-device test, outside CI.',
  ],
  typing: [],
};
const save = () =>
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
try {
  if (only !== 'navigation')
    for (const name of only === 'paragraph' ? ['paragraph'] : Object.keys(fixtures)) {
      console.log(`Story: ${name}`);
      // Open by the real visible row; puppet's native editor document inspector
      // is not used. Its native shell state and touch receipts still work.
      const elements = run('just', ['puppet', 'elements'], false, {
        ...process.env,
        FUTO_PUPPET_TARGET: 'android',
      });
      const line = elements.split('\n').find((s) => s.includes(`note=${folder}/${name} `));
      const ref = line?.match(/^\s*(n\d+)\s/)?.[1];
      if (!ref) throw new Error(`Fixture ${name} is not visible`);
      puppet('tap', JSON.stringify({ ref }));
      if (findCell) {
        puppet(
          'do',
          JSON.stringify([
            ['ToggleNoteActionsMenu', {}],
            ['OpenFind', {}],
            ['SetFindQuery', { query: findCell }],
            ['StepFind', { direction: 1 }],
            ['CloseFind', {}],
          ]),
        );
        const cellElements = puppet('elements');
        const cellLine = cellElements
          .split('\n')
          .find((s) => s.includes(' field ') && s.includes(findCell));
        const cellRef = cellLine?.match(/^\s*(n\d+)\s/)?.[1];
        if (!cellRef) throw new Error('Find did not expose the requested native table cell');
        puppet('tap', JSON.stringify({ ref: cellRef }));
        // R8 may rename the field class; this action exists only for the native cell editor.
        if (!puppet('actions').includes('FinishTableCell'))
          throw new Error('Corpus typing requires the actual native cell field');
      } else puppet('tap', JSON.stringify({ x: 200, y: 275 }));
      if (
        !adb('shell', 'dumpsys', 'activity', 'top').includes(
          'com.futo.notes.textfirst.TextFirstEditText',
        )
      )
        throw new Error('The running editor is not the native Rust renderer');
      const result = await capture(name, typingPlan(findCell ? 'paragraph' : name));
      const body = adb('shell', `cat ${shellQuote(`${state.vaultPath}/${folder}/${name}.md`)}`);
      if (!body.toLowerCase().includes('the quick brown fox jumps over the lazy dog'))
        throw new Error(`${name}: keyboard input was not saved`);
      report.typing.push({
        name,
        ...result,
        events: result.events.length,
        inputEvents: result.events,
      });
      save();
      puppet('do', 'GoBack');
    }
  if (only === 'all' || only === 'navigation') {
    const elements = run('just', ['puppet', 'elements'], false, {
      ...process.env,
      FUTO_PUPPET_TARGET: 'android',
    });
    const plan = [];
    let time = 1500;
    for (let cycle = 0; cycle < cycles; cycle++)
      for (const name of Object.keys(fixtures)) {
        const line = elements.split('\n').find((s) => s.includes(`note=${folder}/${name} `));
        const rect = line?.match(/\s(-?\d+),(-?\d+) (\d+)×(\d+)/);
        if (!rect) throw new Error(`Cannot locate navigation row ${name}`);
        const [, x, y, w, h] = rect.map(Number);
        plan.push({
          time,
          x: Math.round((x + w / 2) * 1.75),
          y: Math.round((y + h / 2) * 1.75),
          label: `open-${name}-${cycle}`,
        });
        plan.push({ time: time + 2000, x: 49, y: 133, label: `close-${name}-${cycle}` });
        time += 4000;
      }
    const result = await capture('navigation', plan);
    report.navigation = navigationTrials(result.frames, result.events);
    report.navigationTraceHealth = result.health;
    save();
  }
  report.typingSummary = report.typing.map((story) => ({
    name: story.name,
    ...frameSummary(story.frames),
    latencyWindows: story.windows,
  }));
  report.failures = failures(report);
  save();
  for (const failure of report.failures) console.error(`FAIL: ${failure}`);
  console.log(
    `${report.failures.length ? 'INVALID EVIDENCE' : 'EVIDENCE COMPLETE (not a performance pass)'}: ${path.join(out, 'report.json')}`,
  );
  if (report.failures.length) process.exitCode = 1;
} catch (error) {
  report.error = error.stack;
  save();
  throw error;
}
