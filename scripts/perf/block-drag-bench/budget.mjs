/* `block-drag-bench.mjs --budget`: the verdict on a run. Kept apart from the
 * CLI (which runs on import) so the verdict logic is unit-testable. */

/**
 * The budgets a block drag has to meet on the REFERENCE PHONE (moto g play
 * 2023, Android 13, System WebView — the low-end device
 * docs/plan/milkdown-transition.md measures against), in milliseconds. They are held on every target
 * the bench runs on: a desktop engine that misses them is a worse regression,
 * not a different budget.
 *
 * - lift: the one frame that carries the lift (long press fired → ghost up).
 * - frame p95: the 95th percentile frame while the finger drags across the
 *   note with the scroller moving — ONE 60 Hz frame, so the preview never
 *   visibly stutters.
 * - drop: the frame that carries the commit (release → document re-laid out).
 */
export const DRAG_BUDGET_MS = Object.freeze({
  liftMs: 100,
  frameP95Ms: 16.7,
  dropMs: 150,
});

/**
 * Every frame figure is the interval between two animation frames, read with
 * `performance.now()`, so a run that never misses a 60 Hz vsync still reads
 * 16.9 or 17.4 ms at its p95 (measured on the emulator, idle host). A missed
 * vsync reads at least two intervals, 33 ms, so this much slack on the frame
 * budget separates jitter from a dropped frame without passing a real miss.
 * The verdict line prints it, so the allowance is never silent.
 */
export const FRAME_CLOCK_SLACK_MS = 2;

const percentile95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Per-operation medians across runs for `key` at `blocks`, or null when the
 * mode never measured it. With `p95`, each run's value is the p95 of its frame
 * samples when it recorded them, else its mean frame (the whole-app target
 * records only the total). */
function perOp(runs, blocks, key, p95) {
  const values = runs
    .filter((x) => x.blocks === blocks && x.result[key])
    .map((x) => {
      const r = x.result[key];
      return p95 && r.samplesMs ? percentile95(r.samplesMs) : r.totalMs / r.reps;
    });
  return values.length ? median(values) : null;
}

/** Whether any run recorded per-frame samples for `key`. */
const hasSamples = (runs, key) => runs.some((x) => x.result[key]?.samplesMs);

/**
 * Which result keys stand for each budgeted phase, per bench mode. The device
 * modes time real frames (`lift frame`, `drop frame`); the editor-page desktop
 * bench times the work synchronously (`lift frame` is the lift plus its first
 * frame, `drop` the commit); the whole-app target times the scroll drag only.
 */
export function budgetKeys({ device, target }) {
  if (target === 'app') return { lift: null, frame: 'scroll frame', drop: null };
  if (device === 'android-app' || device === 'ios-app')
    return { lift: 'lift frame', frame: 'scroll frame', drop: 'drop frame' };
  return { lift: 'lift frame', frame: 'scroll frame', drop: 'drop' };
}

/**
 * Judges every variant at every size. Returns the verdict lines and whether
 * all of them passed. A phase the mode does not measure is reported as such,
 * never as a pass (M11): a run that measured nothing cannot be green.
 */
export function evaluateBudget(results, opts, budget = DRAG_BUDGET_MS) {
  const keys = budgetKeys(opts);
  const lines = [];
  let pass = true;
  let measured = 0;
  for (const { variant, runs } of results) {
    for (const blocks of opts.sizes) {
      const checks = [
        ['lift', keys.lift, false, budget.liftMs, 0],
        [
          hasSamples(runs, keys.frame) ? 'frame p95' : 'frame mean',
          keys.frame,
          true,
          budget.frameP95Ms,
          FRAME_CLOCK_SLACK_MS,
        ],
        ['drop', keys.drop, false, budget.dropMs, 0],
      ];
      for (const [phase, key, p95, limit, slack] of checks) {
        const label = `${variant.label} @ ${blocks} blocks · ${phase}`;
        if (!key) {
          lines.push(`  skip  ${label}: not measured by this mode`);
          continue;
        }
        const value = perOp(runs, blocks, key, p95);
        if (value === null) {
          lines.push(`  skip  ${label}: no samples`);
          continue;
        }
        measured += 1;
        const ok = value <= limit + slack;
        if (!ok) pass = false;
        const allowance = slack ? ` + ${slack} ms frame-clock slack` : '';
        lines.push(
          `  ${ok ? 'ok   ' : 'MISS '} ${label}: ${value.toFixed(1)} ms (budget ${limit} ms${allowance})`,
        );
      }
    }
  }
  if (measured === 0) {
    pass = false;
    lines.push('  MISS  nothing was measured against a budget');
  }
  return { pass, lines };
}
