import { describe, expect, it } from 'vitest';

import { computeCeilingFailures, computeCountFailures } from './debt-ratchet.mjs';

// Regression coverage for the ceilings half of the "fail on a retired/unknown
// baseline key" fix (commit a6c6e2d5 fixed counts; the ceilings loop had the
// identical silent-green hole — an unknown/renamed ceilings key compared
// `now > undefined`, which is always false, so a typo'd or moved key in
// scripts/debt-ratchet.json's "ceilings" object was never actually checked).

describe('computeCeilingFailures', () => {
  it('fails when a computed ceiling metric is missing from the baseline', () => {
    const failures = computeCeilingFailures(
      { agentsMdLines: 245, brandNewMetric: 12 },
      { agentsMdLines: 245 },
      'scripts/debt-ratchet.json',
    );
    expect(failures).toEqual([
      "'brandNewMetric' is computed but missing from scripts/debt-ratchet.json — " +
        'add it with the current value (12) so the ceiling can hold it.',
    ]);
  });

  it('fails when the baseline has a ceiling key this script no longer computes', () => {
    const failures = computeCeilingFailures(
      { agentsMdLines: 245 },
      { agentsMdLines: 245, retiredMetric: 999 },
      'scripts/debt-ratchet.json',
    );
    expect(failures).toEqual([
      "'retiredMetric' is in scripts/debt-ratchet.json but this script no longer computes it — " +
        'a retired ceiling came back, most likely from a rebase carrying an older copy of the file. ' +
        "Delete the 'retiredMetric' entry.",
    ]);
  });

  it('does NOT silently pass a renamed key — reproduces the pre-fix bug', () => {
    // Before the fix, a renamed ceilings key compared the current metric
    // against `undefined` (`now > undefined` is always false), so this
    // mutation — the exact shape a scout used to reproduce the bug — passed
    // silently. It must now fail on both sides of the rename.
    const failures = computeCeilingFailures(
      { agentsMdLinesRenamed: 9999 },
      { agentsMdLines: 245 },
      'scripts/debt-ratchet.json',
    );
    expect(failures.length).toBe(2);
    expect(failures.some((f) => f.includes("'agentsMdLines' is in"))).toBe(true);
    expect(failures.some((f) => f.includes("'agentsMdLinesRenamed' is computed"))).toBe(true);
  });

  it('still fails a metric over its cap when both sides have the key', () => {
    const failures = computeCeilingFailures(
      { agentsMdLines: 300 },
      { agentsMdLines: 245 },
      'scripts/debt-ratchet.json',
    );
    expect(failures).toEqual([
      "'agentsMdLines' is 300, over its ceiling of 245 — the decluttered prose state is regrowing. " +
        'Trim it back under the cap rather than raising the ceiling in scripts/debt-ratchet.json.',
    ]);
  });

  it('passes when a metric is under or at its cap', () => {
    expect(computeCeilingFailures({ agentsMdLines: 245 }, { agentsMdLines: 245 }, 'x')).toEqual([]);
    expect(computeCeilingFailures({ agentsMdLines: 100 }, { agentsMdLines: 245 }, 'x')).toEqual([]);
  });
});

describe('computeCountFailures (unchanged behavior, guards against regressing a6c6e2d5)', () => {
  it('still fails on a retired counter and a computed-but-unbaselined counter', () => {
    const failures = computeCountFailures(
      { a: 1, newCounter: 2 },
      { a: 1, retiredCounter: 5 },
      'scripts/debt-ratchet.json',
    );
    expect(failures.length).toBe(2);
  });
});
