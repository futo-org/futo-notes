#!/usr/bin/env node
// Block-drag benchmark: how much each phase of a ⠿ block drag costs on a large
// note, in milliseconds, in a few seconds per variant.
//
//   node scripts/perf/block-drag-bench.mjs [variant ...] [--repeat 5]
//       [--sizes 1000,3000] [--layout desktop|embed] [--no-cursor-layer]
//       [--target editor|app] [--hide <css selector>] [--snapshot <dir>]
//       [--device android|android-app|ios-app] [--profile <dir>] [--no-selection]
//       [--budget] [--moves-per-frame N] [--gestures <dir>] [--json <file>]
//
// `--json <file>` also writes every run's raw result there, for pooling
// interleaved runs into one median/p90 table (docs/perf/block-drag-baseline.md).
// `--budget` judges every variant against the reference-phone budgets in
// block-drag-bench/budget.mjs (lift, scroll-drag frame p95, drop) and exits
// non-zero on a miss — the gate, not a report. A phase the chosen mode does
// not measure is printed as skipped, never as a pass.
//
// `--moves-per-frame N` (with `--target app`) dispatches N pointermove events
// per animation frame through the real ⠿ handle instead of one. WebKit
// (WebKitGTK, WKWebView) delivers every pointer event the device produces —
// a 1000 Hz mouse is 16 a frame at 60 Hz — where Chromium already aligns
// them to frames; this is how to see what the gesture's own per-frame
// coalescing (handleBlockDrag.ts, mobileBlockDnd.ts) buys on WebKit.
//
// `--gestures <dir>` serves `<dir>/handleBlockDrag.ts` and
// `<dir>/mobileBlockDnd.ts` in place of the working tree's, for every variant
// of the run (labeled `[<dir name>]`). It is how to A/B a change to the
// gesture layer, which the session variants below do not reach, without
// touching the working tree: copy the old files out with `git show`, run once
// with `--gestures` and once without. Not for `--device ios-app`, which builds
// only the working tree.
//
// `--device android` runs the same benchmarks on the phone in $ANDROID_SERIAL,
// in its own Chrome (the same Chromium as its System WebView), inside the real
// editor.html bundle the app ships — see block-drag-bench/phone.ts. Each
// variant is a fresh production build of that bundle (~10s), never staged
// into the app. `--profile <dir>` also saves one Chromium trace per variant
// of the 1000-block scroll-drag (open it in chrome://tracing or Perfetto).
// `--device android-app` is the gate: the REAL app, each variant built into
// it and installed, driven with real touch input — block-drag-bench/app-device.mjs.
// Put `current` last so the app is left on the working tree's bundle.
// `--device ios-app` is the same gate on a physical iPhone, with real touches
// from XCUITest (block-drag-bench/ios-app.mjs). It only has the working tree's
// bundle (no per-variant install), so it takes `current` and `current:line`
// only; any other variant is an error rather than a mislabelled run.
// `--selection` (iOS only) adds the press-and-hold stories, which are on by default elsewhere;
// `--no-selection` skips its press-and-hold text-selection stories.
//
// `--target app` runs only the scroll-drag benchmark, inside the whole app
// shell (the plain-web build, through the real ⠿ handle) instead of the bare
// editor page — see block-drag-bench/app-probe.ts for why. `--hide` removes
// part of the shell for that run, to bisect what costs the frames.
//
// A variant is `current` (the working tree's blockDragSession.ts), a path to
// another copy of that file, and either one with a `:line` suffix to force the
// drop-line mode. For a file with the reflow switch (it uses `ReflowCurtain`)
// that sets the page flag `window.__futoBlockDragReflow = 'off'`; for a
// historical file with `const LIVE_REFLOW = true;` it flips the constant; a file
// with neither is rejected (block-drag-bench/variant.mjs). Every run also
// reports the preview it actually saw (drop line vs curtain) and the bench
// fails when that is not the one the variant asked for.
// Default: `current:line current`.
//
// Why it looks like this: the first version of this test drove the real
// desktop app over its debug bridge — fixed sleeps to open a note and wait for
// the hover-throttled handle, frame-paced everything, and a dead stop whenever
// the window lost focus (KDE sends no frames to a covered window). Ten minutes
// per variant and two stalls in one afternoon. Here the page mounts the real
// editor (scripts/perf/block-drag-bench/main.ts), calls BlockDragSession
// directly, and times each step synchronously with a forced style + layout,
// so the numbers are the work and nothing else. Only the scroll benchmark is
// frame-paced, because painting is only visible through real frames.
//
// The page runs in the system's WebKitGTK — the engine the desktop app ships
// on Linux — through webkitgtk-host.c, compiled on first use. Playwright's
// WebKit was the first choice and does not start on Fedora 44 (it links ICU 74,
// libjpeg 8 and libjxl 0.8). The host is a real window: only the scroll
// benchmark needs frames, and it gets none while the window is covered.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

import { PHONE_REPS, REPS, parseArgs } from './block-drag-bench/args.mjs';
import { evaluateBudget } from './block-drag-bench/budget.mjs';
import { APP_FRAMES, report } from './block-drag-bench/report.mjs';
import { assertModes, forceLineMode, gestureOverride } from './block-drag-bench/variant.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sessionFile = path.join(root, 'src/features/editor/milkdown/blockDragSession.ts');

function parseVariant(spec, gestures) {
  const line = spec.endsWith(':line');
  const name = line ? spec.slice(0, -5) : spec;
  const file = name === 'current' ? sessionFile : path.resolve(name);
  return {
    spec,
    file,
    line,
    gestures,
    label: `${path.basename(name).replace(/^blockDragSession\.|\.ts$/g, '')}${line ? ' (line)' : ''}${gestures ? ` [${path.basename(gestures)}]` : ''}`,
  };
}

/** Serves `variant.file` in place of blockDragSession.ts, optionally with the
 * reflow switched off, and `variant.gestures`' copies of the gesture files.
 * The working tree is never touched. */
function sessionVariantPlugin(variant) {
  return {
    name: 'block-drag-bench-variant',
    enforce: 'pre',
    load(id) {
      const gesture =
        variant.gestures && gestureOverride(id, path.dirname(sessionFile), variant.gestures);
      if (gesture) return readFileSync(gesture, 'utf8');
      if (id.split('?')[0] !== sessionFile) return null;
      let code = readFileSync(variant.file, 'utf8');
      if (variant.line) code = forceLineMode(code, variant.file);
      return code;
    },
  };
}

/** Builds webkitgtk-host.c into node_modules/.cache when it is missing or
 * older than its source. */
function hostBinary() {
  const source = path.join(root, 'scripts/perf/webkitgtk-host.c');
  const dir = path.join(root, 'node_modules/.cache/block-drag-bench');
  const binary = path.join(dir, 'webkitgtk-host');
  if (existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs) return binary;
  mkdirSync(dir, { recursive: true });
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'webkit2gtk-4.1'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/);
  execFileSync('cc', ['-O2', '-Wall', '-o', binary, source, ...flags], { stdio: 'inherit' });
  return binary;
}

/** Runs the page in the host and returns the one message it posts. */
function runInHost(url) {
  return new Promise((resolve, reject) => {
    // The desktop app forces WebKit's non-DMA-BUF renderer on NVIDIA
    // (platform_integration.rs); an inherited value wins, as it does there.
    const env = { ...process.env };
    if (
      env.WEBKIT_DISABLE_DMABUF_RENDERER === undefined &&
      existsSync('/proc/driver/nvidia/version')
    ) {
      env.WEBKIT_DISABLE_DMABUF_RENDERER = '1';
    }
    const child = spawn(hostBinary(), [url, '600'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`webkitgtk-host exited ${code}`));
      const message = JSON.parse(out.trim().split('\n').pop());
      if (message.error) return reject(new Error(message.error));
      console.error(`screen: ${JSON.stringify(message.screen)}`);
      resolve(message.runs);
    });
  });
}

/** `--target app`: loads the probe into the app's own index.html. */
const appProbePlugin = {
  name: 'block-drag-bench-app-probe',
  transformIndexHtml: (html) =>
    html.replace(
      '</body>',
      '<script type="module" src="/scripts/perf/block-drag-bench/app-probe.ts"></script></body>',
    ),
};

async function runVariant(variant, opts) {
  const app = opts.target === 'app';
  const server = await createServer({
    root,
    configFile: path.join(root, app ? 'vite.config.ts' : 'vite.editor.config.ts'),
    plugins: [sessionVariantPlugin(variant), ...(app ? [appProbePlugin] : [])],
    server: { port: 0, strictPort: false, hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const plan = app
    ? {
        repeat: opts.repeat,
        sizes: opts.sizes,
        frames: APP_FRAMES,
        movesPerFrame: opts.movesPerFrame,
        hide: opts.hide,
        // One PNG per note size, mid-drag, on the first run (`--target app`).
        snapshot: opts.snapshot
          ? path.join(opts.snapshot, `${variant.label.replace(/\W+/g, '-')}.png`)
          : '',
      }
    : {
        repeat: opts.repeat,
        sizes: opts.sizes,
        layout: opts.layout,
        cursorLayer: opts.cursorLayer,
        reps: REPS,
      };
  const page = app ? 'index.html' : 'scripts/perf/block-drag-bench/index.html';
  const url =
    `${server.resolvedUrls.local[0]}${page}` +
    `?plan=${encodeURIComponent(JSON.stringify(plan))}${app ? '#/note/new' : ''}`;
  try {
    return await runInHost(url);
  } finally {
    await server.close();
  }
}

/** `--device android`: one production build of editor.html per variant, with
 * the benchmark page (phone.ts) built in, into a cache directory. */
async function buildPhoneBundle(variant) {
  const { build, loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(root, 'vite.editor.config.ts'),
  );
  const outDir = path.join(
    root,
    'node_modules/.cache/block-drag-bench/android',
    variant.label.replace(/\W+/g, '-'),
  );
  // Never stage the bench build into the native shells' assets.
  const plugins = loaded.config.plugins
    .flat(Infinity)
    .filter((p) => p && p.name !== 'stage-native-editor-bundle');
  await build({
    ...loaded.config,
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      sessionVariantPlugin(variant),
      {
        name: 'block-drag-bench-phone-page',
        // `pre`, so Vite sees the tag while it is still collecting entries.
        transformIndexHtml: {
          order: 'pre',
          handler: (html) =>
            html.replace(
              '</body>',
              '<script type="module" src="/scripts/perf/block-drag-bench/phone.ts"></script></body>',
            ),
        },
      },
      ...plugins,
    ],
    build: { ...loaded.config.build, outDir, emptyOutDir: true },
  });
  return path.join(outDir, 'editor.html');
}

async function runVariantOnPhone(variant, opts) {
  const { openInPhoneChrome } = await import('../../tests/lib/android/phoneChrome.mjs');
  const file = await buildPhoneBundle(variant);
  let onTrace = null;
  const page = await openInPhoneChrome({
    file,
    query: 'test',
    onEvent: (method, params) => onTrace?.(method, params),
    ready: 'Boolean(window.__blockDragBench && window.__futoProseMirrorView?.())',
    cwd: root,
  });
  try {
    const runs = [];
    let screen = null;
    for (let r = 0; r < opts.repeat; r += 1) {
      for (const size of opts.sizes) {
        const profiling = opts.profile && r === 0 && size === opts.sizes[0];
        let traced = null;
        if (profiling) traced = await startTrace(page.cdp, (handler) => (onTrace = handler));
        const plan = { repeat: 1, sizes: [size], cursorLayer: false, reps: PHONE_REPS };
        const out = await page.cdp.evaluate(`window.__blockDragBench(${JSON.stringify(plan)})`);
        if (traced)
          await traced.stop(path.join(opts.profile, `${variant.label.replace(/\W+/g, '-')}.json`));
        screen = out.screen;
        runs.push(...out.runs);
      }
    }
    console.error(`screen: ${JSON.stringify(screen)}`);
    return runs;
  } finally {
    await page.close();
  }
}

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink',
  'cc',
  'gpu',
  'viz',
  'benchmark',
  'toplevel',
  'v8.execute',
];

/** Starts a Chromium trace; `listen` installs the CDP event handler. */
async function startTrace(cdp, listen) {
  const events = [];
  let complete;
  const done = new Promise((resolve) => (complete = resolve));
  listen((method, params) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value);
    if (method === 'Tracing.tracingComplete') complete();
  });
  await cdp.send('Tracing.start', {
    traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATEGORIES },
    transferMode: 'ReportEvents',
  });
  return {
    async stop(file) {
      await cdp.send('Tracing.end');
      await done;
      listen(null);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ traceEvents: events }));
      console.error(`trace: ${file} (${events.length} events)`);
    },
  };
}

const opts = parseArgs(process.argv.slice(2));
const started = performance.now();
const results = [];
for (const spec of opts.variants) {
  const variant = parseVariant(spec, opts.gestures);
  const t = performance.now();
  let runs;
  if (opts.device === 'android-app') {
    const app = await import('./block-drag-bench/app-device.mjs');
    await app.installVariant(variant, { root, sessionVariantPlugin });
    runs = await app.runInApp(opts, { root });
  } else if (opts.device === 'ios-app') {
    const ios = await import('./block-drag-bench/ios-app.mjs');
    runs = await ios.runInIosApp(opts, { root, variant });
  } else {
    runs =
      opts.device === 'android'
        ? await runVariantOnPhone(variant, opts)
        : await runVariant(variant, opts);
  }
  assertModes(variant, runs);
  results.push({ variant, runs });
  console.error(`${variant.label}: ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
report(results, opts);
if (opts.json) writeFileSync(opts.json, JSON.stringify({ opts, results }, null, 1));
console.error(`total ${((performance.now() - started) / 1000).toFixed(1)}s`);
const leftovers = results.flatMap((r) =>
  r.runs.filter((x) => x.leftover).map(() => r.variant.label),
);
if (leftovers.length) {
  console.error(
    `FAIL: blocks kept a transform after the drag ended in: ${[...new Set(leftovers)].join(', ')}`,
  );
  process.exit(1);
}
if (opts.budget) {
  const verdict = evaluateBudget(results, opts);
  console.log(`budget (${verdict.pass ? 'PASS' : 'FAIL'}):`);
  for (const line of verdict.lines) console.log(line);
  console.log('');
  if (!verdict.pass) {
    console.error('FAIL: a block-drag phase missed its budget (see above)');
    process.exit(1);
  }
}
