/* `block-drag-bench.mjs`'s command line: flags, their defaults and checks,
 * and the repetition plan per note size. */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { GESTURE_FILES } from './variant.mjs';

/** Repetitions per note size, picked so each benchmark lands near ~300ms. */
export const REPS = {
  1000: { lift: 4, gap: 30, drop: 4, frames: 30 },
  3000: { lift: 2, gap: 10, drop: 2, frames: 30 },
};

/** The same, sized for the reference phone (moto g play 2023, 90Hz) from
 * the working tree's numbers on 2026-10-07. Frames stay at 30 so a p95 has
 * samples to stand on. */
export const PHONE_REPS = {
  1000: { lift: 3, gap: 70, drop: 8, frames: 30 },
  3000: { lift: 1, gap: 50, drop: 5, frames: 30 },
};

export function parseArgs(argv) {
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
    budget: false,
    movesPerFrame: 1,
    gestures: '',
    json: '',
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
    else if (arg === '--budget') opts.budget = true;
    else if (arg === '--moves-per-frame') opts.movesPerFrame = Number(argv[++i]);
    else if (arg === '--gestures') opts.gestures = path.resolve(argv[++i]);
    else if (arg === '--json') opts.json = path.resolve(argv[++i]);
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
  if (opts.gestures) {
    if (opts.device === 'ios-app')
      throw new Error(
        "--gestures needs a per-variant build; --device ios-app has only the working tree's",
      );
    const missing = GESTURE_FILES.filter((n) => !existsSync(path.join(opts.gestures, n)));
    if (missing.length) throw new Error(`--gestures ${opts.gestures} lacks ${missing.join(', ')}`);
  }
  if (!Number.isInteger(opts.movesPerFrame) || opts.movesPerFrame < 1)
    throw new Error(`--moves-per-frame needs a whole number of at least 1`);
  if (opts.movesPerFrame > 1 && opts.target !== 'app')
    throw new Error('--moves-per-frame drives the real handle: it needs --target app');
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
