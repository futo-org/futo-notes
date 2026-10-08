#!/usr/bin/env node
// Block-drag benchmark: how much each phase of a ⠿ block drag costs on a large
// note, in milliseconds, in a few seconds per variant.
//
//   node scripts/perf/block-drag-bench.mjs [variant ...] [--repeat 5]
//       [--sizes 1000,3000] [--layout desktop|embed] [--no-cursor-layer]
//       [--target editor|app] [--hide <css selector>] [--snapshot <dir>]
//       [--device android|android-app|ios-app] [--profile <dir>] [--no-selection]
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

import { assertModes, forceLineMode } from './block-drag-bench/variant.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sessionFile = path.join(root, 'src/features/editor/milkdown/blockDragSession.ts');

/** Repetitions per note size, picked so each benchmark lands near ~300ms. */
const REPS = {
  1000: { lift: 4, gap: 30, drop: 4, frames: 30 },
  3000: { lift: 2, gap: 10, drop: 2, frames: 30 },
};

/** The same, sized for the reference phone (moto g play 2023, 90Hz) from
 * the working tree's numbers on 2026-10-07. Frames stay at 30 so a p95 has
 * samples to stand on. */
const PHONE_REPS = {
  1000: { lift: 3, gap: 70, drop: 8, frames: 30 },
  3000: { lift: 1, gap: 50, drop: 5, frames: 30 },
};

function parseArgs(argv) {
  const opts = {
    variants: [],
    repeat: null,
    sizes: [1000, 3000],
    layout: 'desktop',
    cursorLayer: true,
    target: 'editor',
    hide: '',
    snapshot: '',
    device: 'desktop',
    profile: '',
    noSelection: false,
    selection: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repeat') opts.repeat = Number(argv[++i]);
    else if (arg === '--sizes') opts.sizes = argv[++i].split(',').map(Number);
    else if (arg === '--layout') opts.layout = argv[++i];
    else if (arg === '--no-cursor-layer') opts.cursorLayer = false;
    else if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--hide') opts.hide = argv[++i];
    else if (arg === '--snapshot') opts.snapshot = path.resolve(argv[++i]);
    else if (arg === '--device') opts.device = argv[++i];
    else if (arg === '--no-selection') opts.noSelection = true;
    else if (arg === '--selection') opts.selection = true;
    else if (arg === '--profile') opts.profile = path.resolve(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else opts.variants.push(arg);
  }
  // The iOS gate is the shipping mode, once; the comparison and the selection
  // holds are opt-in (`current:line`, `--selection`).
  if (opts.repeat == null) opts.repeat = opts.device === 'ios-app' ? 1 : 5;
  if (opts.variants.length === 0)
    opts.variants = opts.device === 'ios-app' ? ['current'] : ['current:line', 'current'];
  if (!['desktop', 'android', 'android-app', 'ios-app'].includes(opts.device))
    throw new Error(`unknown device ${opts.device}`);
  if (opts.device === 'ios-app') {
    const bad = opts.variants.filter((v) => v !== 'current' && v !== 'current:line');
    if (bad.length)
      throw new Error(
        `--device ios-app only runs the working tree's bundle: variants current and current:line, not ${bad.join(', ')}`,
      );
  }
  if (opts.device !== 'desktop') {
    if (opts.target !== 'editor')
      throw new Error(`--device ${opts.device} runs the editor target only`);
    opts.layout = 'embed';
    opts.cursorLayer = false;
  }
  for (const size of opts.sizes) {
    if (!repsFor(opts)[size])
      throw new Error(`no repetition plan for size ${size} (have ${Object.keys(REPS)})`);
  }
  return opts;
}

const repsFor = (opts) => (opts.device === 'desktop' ? REPS : PHONE_REPS);

function parseVariant(spec) {
  const line = spec.endsWith(':line');
  const name = line ? spec.slice(0, -5) : spec;
  const file = name === 'current' ? sessionFile : path.resolve(name);
  return {
    spec,
    file,
    line,
    label: `${path.basename(name).replace(/^blockDragSession\.|\.ts$/g, '')}${line ? ' (line)' : ''}`,
  };
}

/** Serves `variant.file` in place of blockDragSession.ts, optionally with the
 * reflow switched off. The working tree is never touched. */
function sessionVariantPlugin(variant) {
  return {
    name: 'block-drag-bench-variant',
    enforce: 'pre',
    load(id) {
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

/** Frames timed by `--target app`. */
const APP_FRAMES = 60;

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

const percentile95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function report(results, opts) {
  const benches =
    opts.target === 'app'
      ? ['scroll frame', '  of which JS', '  of which style+layout']
      : opts.device === 'android-app' || opts.device === 'ios-app'
        ? [
            'lift frame',
            'gap frame',
            'gap frame p95',
            'scroll frame',
            'scroll frame p95',
            'drop frame',
          ]
        : [
            'lift+cancel',
            'lift frame',
            'first move',
            'gap change',
            'drop',
            'gap frame',
            'gap frame p95',
            'scroll frame',
            'scroll frame p95',
          ];
  const labelWidth = 26;
  const colWidth = Math.max(...results.map((r) => r.variant.label.length), 24) + 2;
  const pad = (s, w) => String(s).padStart(w);
  const engine = {
    desktop: 'WebKitGTK',
    android: 'Android Chrome (phone)',
    'android-app': 'REAL Android app (phone), long-press gesture',
    'ios-app': 'REAL iOS app (iPhone), XCUITest long-press gesture',
  }[opts.device];
  console.log(
    `\n${engine}, ${opts.target === 'app' ? `whole app${opts.hide ? ` minus ${opts.hide}` : ''}` : `${opts.layout} layout`}, cursor layer ${opts.cursorLayer ? 'on' : 'off'}, ${opts.repeat} runs each; ms per operation, median (min–max)\n`,
  );
  console.log(''.padEnd(labelWidth) + results.map((r) => pad(r.variant.label, colWidth)).join(''));
  for (const size of opts.sizes) {
    const modes = results.map((r) => {
      const runs = r.runs.filter((x) => x.blocks === size);
      const mode = [...new Set(runs.map((x) => x.mode))].join('/');
      return (
        `${mode}, scrolls ${runs[0].scroller}` + (runs.some((x) => x.leftover) ? ' LEFTOVER' : '')
      );
    });
    console.log(`${size} blocks`.padEnd(labelWidth) + modes.map((m) => pad(m, colWidth)).join(''));
    for (const bench of benches) {
      const p95 = bench.endsWith(' p95');
      const key = p95 ? bench.slice(0, -4) : bench;
      const sample = results[0].runs.find((x) => x.blocks === size)?.result[key];
      const count = opts.target === 'app' ? APP_FRAMES : sample?.reps;
      const cells = results.map((r) => {
        const perOp = r.runs
          .filter((x) => x.blocks === size && x.result[key])
          .map((x) =>
            p95
              ? percentile95(x.result[key].samplesMs)
              : x.result[key].totalMs / (opts.target === 'app' ? APP_FRAMES : x.result[key].reps),
          );
        if (perOp.length === 0) return '—';
        const lo = Math.min(...perOp).toFixed(0);
        const hi = Math.max(...perOp).toFixed(0);
        return `${median(perOp).toFixed(1)} (${lo}–${hi})`;
      });
      console.log(
        `  ${bench}${p95 ? '' : ` ×${count}`}`.padEnd(labelWidth) +
          cells.map((c) => pad(c, colWidth)).join(''),
      );
    }
  }
  console.log('');
}

const opts = parseArgs(process.argv.slice(2));
const started = performance.now();
const results = [];
for (const spec of opts.variants) {
  const variant = parseVariant(spec);
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
