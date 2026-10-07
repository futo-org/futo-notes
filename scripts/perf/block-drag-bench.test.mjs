import { describe, expect, it } from 'vitest';

import { assertModes, forceLineMode } from './block-drag-bench/variant.mjs';
import { toRuns, validateRecords } from './block-drag-bench/ios-app.mjs';

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

const plan = { sizes: [1000, 3000], repeat: 2, selection: true, line: false };
const samples = [16, 17, 33];

function healthy() {
  const records = [{ kind: 'hello' }];
  for (const blocks of plan.sizes) {
    for (let rep = 0; rep < plan.repeat; rep += 1) {
      const base = { blocks, rep, vsync: 8.3 };
      records.push(
        { kind: 'arm-sync', ...base },
        {
          kind: 'lift',
          ...base,
          liftedAfterMs: 340,
          liftFrame: 40,
          dragSamples: samples,
          dropFrame: 90,
          moves: 50,
          mode: 'reflow',
          leftover: 0,
        },
        { kind: 'edge', ...base, scrolledPx: 800, scrollSamples: samples },
        { kind: 'scroll-arm', ...base, armWindowFrame: 20, scrollWindow: { p95: 17 } },
      );
    }
  }
  for (const name of ['strong', 'em', 'link', 'plain']) records.push({ kind: 'selection', name });
  records.push({ kind: 'tap' }, { kind: 'finished' });
  return records;
}

describe('validateRecords', () => {
  it('accepts a complete run and shapes it for the report', () => {
    expect(() => validateRecords(healthy(), plan)).not.toThrow();
    const runs = toRuns(healthy());
    expect(runs).toHaveLength(4);
    expect(runs[0].result['gap frame'].samplesMs).toEqual(samples);
  });

  it.each([
    ['no finished record', (r) => r.filter((x) => x.kind !== 'finished'), /did not finish/],
    ['a probe error', (r) => [...r, { kind: 'error', message: 'boom' }], /probe error: boom/],
    ['a missing rep', (r) => r.filter((x, i) => !(x.kind === 'edge' && i < 8)), /edge records/],
    [
      'a lift that never lifted',
      (r) => r.map((x) => (x.kind === 'lift' ? { ...x, liftedAfterMs: null } : x)),
      /never lifted/,
    ],
    [
      'an edge hold that never scrolled',
      (r) => r.map((x) => (x.kind === 'edge' ? { ...x, scrolledPx: 0 } : x)),
      /never auto-scrolled/,
    ],
    [
      'the wrong preview',
      (r) => r.map((x) => (x.kind === 'lift' ? { ...x, mode: 'line' } : x)),
      /variant asked for reflow/,
    ],
    ['a missing selection story', (r) => r.filter((x) => x.name !== 'em'), /clean em/],
    [
      'a skipped selection story',
      (r) =>
        r.map((x) => (x.name === 'link' ? { kind: 'selection', name: 'link', error: 'x' } : x)),
      /clean link/,
    ],
  ])('rejects %s', (_, mutate, message) => {
    expect(() => validateRecords(mutate(healthy()), plan)).toThrow(message);
  });
});
