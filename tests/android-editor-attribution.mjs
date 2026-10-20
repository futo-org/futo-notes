#!/usr/bin/env node
/**
 * WHERE a keystroke's time goes, by source file — the attribution issue #113
 * asks for, measured in the REAL native Android app on $ANDROID_SERIAL.
 *
 * The shipped editor.html is minified with no map, so a CPU profile of it
 * names `Ft editor.html:40` and nothing else. This script builds the same
 * bundle with an INLINE source map, stages it into the app's assets, installs
 * the debug app, opens a seeded note, loads a fixture through `FutoEditor`,
 * runs the gate's own keystroke loop (tests/lib/editorDevicePerfSnippets.mjs)
 * under `Profiler.start/stop`, and resolves every sampled frame through the
 * map (tests/lib/profileAttribution.mjs). The plain bundle is rebuilt and
 * re-staged afterwards, so the sourcemapped one never outlives the run (M16).
 *
 * It also reports the keystroke p95 the loop measured and, when the bundle
 * carries it, the editor's own keystroke tripwire readout
 * (`__futoTest.keystrokeFrameSamplesMs`, src/shared/perf/interactionLedger.ts)
 * — so one run can both attribute and compare bundles.
 *
 *   export ANDROID_SERIAL=<device>                   # adb devices -l
 *   node tests/android-editor-attribution.mjs                                   # 1000-lines-blocks, profiled
 *   node tests/android-editor-attribution.mjs --fixture 10000-lines-blocks --top 20
 *   node tests/android-editor-attribution.mjs --no-profile --samples 40          # keystroke p95 only
 *   node tests/android-editor-attribution.mjs --bundle path/to/editor.html       # install THAT bundle instead of building
 *
 * The verdict for #113 needs the low-end reference phone: an emulator on a
 * desktop CPU shows the SHAPE of the cost, not whether it fits a frame there.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createAndroidDevice } from './lib/android/device.mjs';
import { DEV_PACKAGE, openEditorPage } from './lib/android/editorPage.mjs';
import { buildEditorBundle, installDebugApp, stageEditorBundle } from './lib/editorBundleBuild.mjs';
import { blockFixture, lineFixture, median, percentile95 } from './lib/editorDevicePerf.mjs';
import { keystrokeExpression, loadExpression } from './lib/editorDevicePerfSnippets.mjs';
import {
  attributeProfile,
  formatAttribution,
  scriptsFromParsedEvents,
} from './lib/profileAttribution.mjs';

const ROOT = process.cwd();
const NOTE_TITLE = 'Attribution fixture';
const ATTRIBUTION_OUT_DIR = 'build/native-editor-attribution';
const PLAIN_OUT_DIR = 'build/native-editor';
const LOCAL_NOTE_PATH = 'tests/editor-gauntlet/local/device-perf-note.md';

// ── Arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fixtures = [];
let samples = 25;
let profile = true;
let top = 15;
let bundleOverride = null;
let keepStaged = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--fixture') fixtures.push(args[++i]);
  else if (arg === '--samples') samples = Number(args[++i]);
  else if (arg === '--top') top = Number(args[++i]);
  else if (arg === '--no-profile') profile = false;
  else if (arg === '--bundle') bundleOverride = path.resolve(args[++i]);
  else if (arg === '--keep-staged') keepStaged = true;
  else {
    console.error(
      `Unrecognized argument: ${arg}\nSupported: --fixture <name> (repeatable), --samples <n>, --top <n>, --no-profile, --bundle <editor.html>, --keep-staged`,
    );
    process.exit(2);
  }
}
if (fixtures.length === 0) fixtures.push('1000-lines-blocks');
if (!process.env.ANDROID_SERIAL) {
  console.error(
    'Set $ANDROID_SERIAL to the device (`adb devices -l`; pool: just qa-claim android).',
  );
  process.exit(1);
}
if (bundleOverride && !existsSync(bundleOverride)) {
  console.error(`no bundle at ${bundleOverride}`);
  process.exit(1);
}

function buildFixture(name) {
  let match = /^(\d+)-lines-blocks$/.exec(name);
  if (match) return blockFixture(Number(match[1]));
  match = /^(\d+)-lines$/.exec(name);
  if (match) return lineFixture(Number(match[1]));
  if (name === 'real-note') {
    const file = process.env.FUTO_PERF_NOTE || LOCAL_NOTE_PATH;
    if (!existsSync(file)) throw new Error(`no real note at ${file} (set $FUTO_PERF_NOTE)`);
    return readFileSync(file, 'utf8');
  }
  throw new Error(`unknown fixture "${name}"`);
}

// ── Build, stage, install ──────────────────────────────────────────

let bundle = bundleOverride;
if (!bundle) {
  process.stdout.write(
    profile ? 'building editor.html with inline source maps … ' : 'building editor.html … ',
  );
  const t0 = Date.now();
  bundle = await buildEditorBundle({
    root: ROOT,
    outDir: profile ? ATTRIBUTION_OUT_DIR : PLAIN_OUT_DIR,
    sourcemap: profile ? 'inline' : false,
  });
  console.log(
    `${((Date.now() - t0) / 1000).toFixed(1)}s (${(readFileSync(bundle).length / 1e6).toFixed(1)} MB)`,
  );
}
stageEditorBundle(ROOT, bundle);
process.stdout.write('installing the debug app … ');
installDebugApp(ROOT);
console.log('done');

// ── Measure ────────────────────────────────────────────────────────

const device = createAndroidDevice({ pkg: DEV_PACKAGE });
device.requireReady();
const parsedScripts = [];
let page = null;
let failed = false;
try {
  // Inside the try: a launch that fails must still restore the plain bundle.
  page = await openEditorPage(device, {
    root: ROOT,
    noteTitle: NOTE_TITLE,
    onEvent: (method, params) => {
      if (method === 'Debugger.scriptParsed' && params.sourceMapURL) parsedScripts.push(params);
    },
  });
  const { cdp } = page;
  const model = device.adb.shell('getprop ro.product.model').trim();
  console.log(
    `Device: ${model} (${process.env.ANDROID_SERIAL}); bundle: ${path.relative(ROOT, bundle)}`,
  );
  await cdp.send('Runtime.enable');
  if (profile) {
    // Enabling the debugger replays `scriptParsed` for every script already on
    // the page; the inline map rides along as a data: URL.
    await cdp.send('Debugger.enable');
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  }
  const tripwire = await cdp.evaluate(
    `typeof window.__futoTest?.keystrokeFrameSamplesMs === 'function'`,
  );
  console.log(`Keystroke tripwire in this bundle: ${tripwire ? 'yes' : 'no'}`);

  for (const name of fixtures) {
    const content = buildFixture(name);
    process.stdout.write(`\n${name} … `);
    await cdp.evaluate(loadExpression(content));
    if (tripwire) await cdp.evaluate(`window.__futoTest.clearInteractions('keystroke')`);
    if (profile) await cdp.send('Profiler.start');
    const typed = await cdp.evaluate(keystrokeExpression(samples));
    const stopped = profile ? await cdp.send('Profiler.stop') : null;
    console.log(
      `keystroke p95 ${percentile95(typed.synchronousSamplesMs).toFixed(1)} ms, ` +
        `median ${median(typed.synchronousSamplesMs).toFixed(1)} ms ` +
        `(settled p95 ${percentile95(typed.settledToPaintSamplesMs).toFixed(1)} ms) over ${samples} keystrokes`,
    );
    console.log(`  sync ms: ${typed.synchronousSamplesMs.map((ms) => ms.toFixed(1)).join(' ')}`);
    if (tripwire) {
      const frames = await cdp.evaluate(`window.__futoTest.keystrokeFrameSamplesMs()`);
      console.log(
        `  tripwire (dispatch → frame): ${frames.length} samples, p95 ${percentile95(frames).toFixed(1)} ms, median ${median(frames).toFixed(1)} ms`,
      );
    }
    if (stopped) {
      const scripts = scriptsFromParsedEvents(parsedScripts);
      if (scripts.size === 0) {
        failed = true;
        console.log(
          '  NO inline source map reached the profiler — the bundle was not built with one (M11: this run attributes nothing).',
        );
        continue;
      }
      // The raw profile too, for DevTools' Performance panel (gitignored build/).
      mkdirSync(path.join(ROOT, ATTRIBUTION_OUT_DIR), { recursive: true });
      const saved = path.join(ATTRIBUTION_OUT_DIR, `keystrokes-${name}.cpuprofile`);
      writeFileSync(path.join(ROOT, saved), JSON.stringify(stopped.profile));
      console.log(`  raw profile: ${saved}`);
      const summary = attributeProfile(stopped.profile, scripts, { top });
      console.log(
        formatAttribution(summary, { title: `  CPU profile of ${samples} keystrokes on ${name}` }),
      );
    }
  }
} finally {
  page?.close();
  if (!keepStaged && (profile || bundleOverride)) {
    // Leave the tree as a normal build leaves it: the plain bundle staged.
    process.stdout.write('\nrestoring the plain editor.html in the native assets … ');
    stageEditorBundle(ROOT, await buildEditorBundle({ root: ROOT, outDir: PLAIN_OUT_DIR }));
    console.log('done');
  }
}
if (failed) process.exit(1);
