import { describe, expect, it } from 'vitest';

import { planMarkdownChunks } from '../../src/features/editor/milkdown/markdownChunks';
import { lineFixture as gauntletLineFixture } from '../editor-gauntlet/performanceFloor';
import {
  DEVICE_BUDGET,
  blockFixture,
  evaluateDeviceFloor,
  lineFixture,
} from './editorDevicePerf.mjs';

/**
 * The device leg of the editor performance floor (issue #106, plan §5): on the
 * low-end Android reference phone the budget is time-to-INTERACTIVE-first-
 * viewport under 1s at real-note sizes and keystroke p95 under 16ms at every
 * size; above real-note sizes the assertion is "no cliff", measured on
 * time-to-complete per line against a smaller reference fixture.
 */

const fixtures = [
  { name: '1000-lines', openPolicy: { kind: 'hard' } },
  { name: '10000-lines', openPolicy: { kind: 'hard' } },
  { name: '50000-lines', openPolicy: { kind: 'linear', reference: '10000-lines' } },
];

const result = (name, lines, overrides = {}) => ({
  fixture: name,
  lines,
  interactiveMs: 200,
  completeMs: lines / 10,
  keystrokeSynchronousP95Ms: 8,
  ...overrides,
});

const cleanRun = () => [
  result('1000-lines', 1_000),
  result('10000-lines', 10_000),
  result('50000-lines', 50_000),
];

describe('evaluateDeviceFloor', () => {
  it('passes a run where every budget holds', () => {
    expect(evaluateDeviceFloor(fixtures, cleanRun())).toEqual([]);
  });

  it('flags a hard fixture whose first viewport is not interactive under the budget', () => {
    const results = cleanRun();
    results[1] = result('10000-lines', 10_000, {
      interactiveMs: DEVICE_BUDGET.interactiveMs,
    });
    const violations = evaluateDeviceFloor(fixtures, results);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '10000-lines', kind: 'interactive-budget' });
    expect(violations[0].detail).toContain('1000ms');
  });

  it('applies the keystroke budget to every fixture, linear ones included', () => {
    const results = cleanRun();
    results[2] = result('50000-lines', 50_000, { keystrokeSynchronousP95Ms: 16 });
    const violations = evaluateDeviceFloor(fixtures, results);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '50000-lines', kind: 'keystroke-budget' });
  });

  it('does not hold a linear fixture to the interactive budget', () => {
    const results = cleanRun();
    // 50k opens slowly in absolute terms but scales linearly per line.
    results[2] = result('50000-lines', 50_000, { interactiveMs: 4_000, completeMs: 5_000 });
    expect(evaluateDeviceFloor(fixtures, results)).toEqual([]);
  });

  it('flags a cliff: per-line complete cost beyond the factor of its reference', () => {
    const results = cleanRun();
    // Reference costs 0.1ms/line; 50k at 0.26ms/line is past the 2.5x factor.
    results[2] = result('50000-lines', 50_000, { completeMs: 13_000 });
    const violations = evaluateDeviceFloor(fixtures, results);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '50000-lines', kind: 'open-cliff' });
  });

  it('reports a fixture that produced no measurement instead of skipping it', () => {
    const violations = evaluateDeviceFloor(fixtures, cleanRun().slice(0, 2));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '50000-lines', kind: 'missing-measurement' });
  });

  it('reports a linear fixture whose reference is missing from the run', () => {
    const lonely = [{ name: '50000-lines', openPolicy: { kind: 'linear', reference: 'absent' } }];
    const violations = evaluateDeviceFloor(lonely, [result('50000-lines', 50_000)]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '50000-lines', kind: 'missing-reference' });
  });

  /**
   * Why the device ladder needs two generators, locked so the reason cannot
   * rot: the interactive-first-viewport budget is only meaningful on a document
   * progressive open will actually chunk, and the desktop floor's `lineFixture`
   * is not one. Measured on the reference phone (moto g play 2023), the 10k
   * `lineFixture` opened in 15.7s — it declines chunking and loads whole, so no
   * amount of editor work could put it under 1s.
   */
  describe('fixture shapes', () => {
    it('lineFixture offers progressive open no cut at all', () => {
      const plan = planMarkdownChunks(lineFixture(10_000));
      expect(plan.chunked).toBe(false);
      expect(plan.declined).toBe('no-boundary');
    });

    it('blockFixture is chunkable, so the interactive budget can be met at all', () => {
      const plan = planMarkdownChunks(blockFixture(10_000));
      expect(plan.chunked).toBe(true);
      // A first chunk near the planner's 80-line budget is the whole point:
      // the user waits for THIS, not for the document.
      expect(plan.chunks[0].split('\n').length).toBeLessThan(200);
      expect(plan.chunks.length).toBeGreaterThan(5);
    });

    it('gives the containment stylesheet real top-level blocks to skip', () => {
      // Blank-line separated blocks; lineFixture's lazy continuation fuses its
      // lines into a handful of huge ones, which containment cannot help.
      expect(blockFixture(1_000).split('\n\n').length).toBeGreaterThan(400);
      expect(lineFixture(1_000).split('\n\n').length).toBe(1);
    });

    it('returns exactly the requested line count, so per-line costs are honest', () => {
      for (const lines of [1, 2, 3, 999, 1_000]) {
        expect(blockFixture(lines).split('\n')).toHaveLength(lines);
      }
    });

    it('reuses the same content lines, so only block separation differs', () => {
      const blocked = blockFixture(9).split('\n');
      expect(blocked.filter((line) => line !== '')).toEqual(lineFixture(5).split('\n'));
    });
  });

  it('builds the SAME line fixture as the desktop performance floor', () => {
    // Differential lock: the device numbers are only comparable to the desktop
    // floor's if both runs open the same document. The desktop generator is
    // TypeScript inside the Playwright harness and the device runner is plain
    // node, so the copy here is deliberate — this test is what keeps the two
    // in lockstep (AGENTS.md §12).
    for (const lines of [1, 7, 1_000]) {
      expect(lineFixture(lines)).toBe(gauntletLineFixture(lines));
    }
  });

  it('flags a fixture the editor refused to open, instead of scoring it', () => {
    const results = cleanRun();
    results[1] = { fixture: '10000-lines', lines: 10_000, loadError: 'Cannot close `paragraph`' };
    const violations = evaluateDeviceFloor(fixtures, results);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '10000-lines', kind: 'load-failure' });
    expect(violations[0].detail).toContain('Cannot close');
  });

  it('flags a measured fixture only on keystrokes, never on open', () => {
    const measured = [{ name: 'big-note', openPolicy: { kind: 'measured' } }];
    const slowOpen = [result('big-note', 14_000, { interactiveMs: 9_000, completeMs: 60_000 })];
    expect(evaluateDeviceFloor(measured, slowOpen)).toEqual([]);
    const slowKeys = [result('big-note', 14_000, { keystrokeSynchronousP95Ms: 40 })];
    expect(evaluateDeviceFloor(measured, slowKeys)).toMatchObject([
      { fixture: 'big-note', kind: 'keystroke-budget' },
    ]);
  });
});
