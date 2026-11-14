import { describe, expect, it } from 'vitest';

import { assertModes, forceLineMode, gestureOverride } from './block-drag-bench/variant.mjs';
import {
  DRAG_BUDGET_MS,
  FRAME_CLOCK_SLACK_MS,
  budgetKeys,
  evaluateBudget,
} from './block-drag-bench/budget.mjs';

describe('gestureOverride', () => {
  const milkdown = '/repo/src/features/editor/milkdown';
  it('serves the directory copy of each gesture file, query or not', () => {
    expect(gestureOverride(`${milkdown}/handleBlockDrag.ts`, milkdown, '/tmp/base')).toBe(
      '/tmp/base/handleBlockDrag.ts',
    );
    expect(gestureOverride(`${milkdown}/mobileBlockDnd.ts?v=1`, milkdown, '/tmp/base')).toBe(
      '/tmp/base/mobileBlockDnd.ts',
    );
  });

  it('leaves every other module alone, including same-named files elsewhere', () => {
    expect(gestureOverride(`${milkdown}/blockDragSession.ts`, milkdown, '/tmp/base')).toBeNull();
    expect(gestureOverride('/elsewhere/handleBlockDrag.ts', milkdown, '/tmp/base')).toBeNull();
  });
});

describe('forceLineMode', () => {
  it('sets the page flag on a file that routes through the curtain', () => {
    const out = forceLineMode('const c = ReflowCurtain.measure(view);', 'x.ts');
    expect(out.startsWith("window.__futoBlockDragReflow = 'off';")).toBe(true);
  });

  it('flips the legacy constant', () => {
    const out = forceLineMode('a\nconst LIVE_REFLOW = true;\nb', 'old.ts');
    expect(out).toBe('a\nconst LIVE_REFLOW = false;\nb');
  });

  it('rejects a file with neither the constant nor the switch', () => {
    expect(() => forceLineMode('class BlockDragSession {}', 'old.ts')).toThrow(/neither/);
  });
});

describe('assertModes', () => {
  it('fails a run that showed another preview than the variant asked for', () => {
    expect(() => assertModes({ spec: 'old.ts:line', line: true }, [{ mode: 'reflow' }])).toThrow(
      /asked for the line preview/,
    );
    expect(() => assertModes({ spec: 'current', line: false }, [{ mode: 'unknown' }])).toThrow();
    expect(() => assertModes({ spec: 'current', line: false }, [{ mode: 'reflow' }])).not.toThrow();
  });
});

/** One variant's runs at 1000 blocks, with the device-mode keys. */
function deviceRuns({ lift = 40, frames = [10, 12, 14], drop = 90 } = {}) {
  return [
    {
      blocks: 1000,
      mode: 'reflow',
      result: {
        'lift frame': { reps: 1, totalMs: lift },
        'scroll frame': { reps: frames.length, totalMs: 36, samplesMs: frames },
        'drop frame': { reps: 1, totalMs: drop },
      },
    },
  ];
}

const deviceOpts = { device: 'android-app', target: 'editor', sizes: [1000] };

describe('evaluateBudget', () => {
  it('passes a run inside every budget and names each phase', () => {
    const verdict = evaluateBudget(
      [{ variant: { label: 'current' }, runs: deviceRuns() }],
      deviceOpts,
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.lines).toHaveLength(3);
    expect(verdict.lines.every((l) => l.includes('ok'))).toBe(true);
  });

  it.each([
    ['lift', { lift: DRAG_BUDGET_MS.liftMs + 1 }, /lift: 101\.0 ms/],
    ['frame p95', { frames: [10, 12, 30] }, /frame p95: 30\.0 ms/],
    ['drop', { drop: DRAG_BUDGET_MS.dropMs + 0.5 }, /drop: 150\.5 ms/],
  ])('fails when the %s misses its budget', (_phase, overrides, line) => {
    const verdict = evaluateBudget(
      [{ variant: { label: 'current' }, runs: deviceRuns(overrides) }],
      deviceOpts,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.lines.find((l) => l.startsWith('  MISS'))).toMatch(line);
  });

  // Frame figures are vsync intervals: a smooth 60 Hz run jitters just past
  // 16.7 ms, a dropped frame reads 33 ms. The slack passes the first only.
  it('passes vsync jitter on the frame budget and still fails a missed frame', () => {
    const judge = (frames) =>
      evaluateBudget([{ variant: { label: 'current' }, runs: deviceRuns({ frames }) }], deviceOpts);
    const smooth = judge([16.6, 16.7, 16.9]);
    expect(smooth.pass).toBe(true);
    expect(smooth.lines.find((l) => l.includes('frame p95'))).toContain(
      `+ ${FRAME_CLOCK_SLACK_MS} ms frame-clock slack`,
    );
    expect(judge([16.7, 16.7, DRAG_BUDGET_MS.frameP95Ms + FRAME_CLOCK_SLACK_MS + 0.1]).pass).toBe(
      false,
    );
    expect(judge([16.7, 16.7, 33.3]).pass).toBe(false);
  });

  it('skips the phases the whole-app target does not measure, and judges the one it does', () => {
    const runs = [
      {
        blocks: 1000,
        mode: 'reflow',
        result: { 'scroll frame': { reps: 60, totalMs: 600 } },
      },
    ];
    const verdict = evaluateBudget([{ variant: { label: 'current' }, runs }], {
      device: 'desktop',
      target: 'app',
      sizes: [1000],
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.lines.filter((l) => l.startsWith('  skip'))).toHaveLength(2);
    // No per-frame samples there: the mean frame is judged, and says so.
    expect(verdict.lines.find((l) => l.includes('frame mean'))).toMatch(/ok .*10\.0 ms/);
  });

  it('never passes a run that measured nothing (M11)', () => {
    const verdict = evaluateBudget([{ variant: { label: 'current' }, runs: [] }], deviceOpts);
    expect(verdict.pass).toBe(false);
    expect(verdict.lines.at(-1)).toMatch(/nothing was measured/);
  });

  it('maps each mode to the keys it records', () => {
    expect(budgetKeys({ device: 'desktop', target: 'editor' })).toEqual({
      lift: 'lift frame',
      frame: 'scroll frame',
      drop: 'drop',
    });
    expect(budgetKeys({ device: 'ios-app', target: 'editor' }).drop).toBe('drop frame');
    expect(budgetKeys({ device: 'desktop', target: 'app' }).lift).toBeNull();
  });
});
