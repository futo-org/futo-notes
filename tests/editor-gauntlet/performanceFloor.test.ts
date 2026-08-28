import { describe, expect, it } from 'vitest';

import {
  MILKDOWN_FLOOR_FIXTURES,
  type FloorFixture,
  PERFORMANCE_BUDGET,
  evaluatePerformanceFloor,
  type PerformanceResult,
} from './performanceFloor';

function result(overrides: Partial<PerformanceResult>): PerformanceResult {
  return {
    fixture: '10k-lines',
    lines: 10_000,
    bytes: 500_000,
    openMs: 500,
    openSynchronousMs: 400,
    keystrokeSynchronousP95Ms: 4,
    keystrokeSettledToPaintP95Ms: 12,
    ...overrides,
  };
}

describe('MILKDOWN_FLOOR_FIXTURES', () => {
  it('hard-gates open only at sizes real notes reach', () => {
    const hard = MILKDOWN_FLOOR_FIXTURES.filter((f) => f.openPolicy.kind === 'hard');
    expect(hard.map((f) => f.name)).toEqual(['1k-lines', '10k-lines', '1mb-adversarial']);
  });

  it('gives every linear-open fixture a hard-gated reference of the same shape', () => {
    for (const fixture of MILKDOWN_FLOOR_FIXTURES) {
      if (fixture.openPolicy.kind !== 'linear') continue;
      const reference = MILKDOWN_FLOOR_FIXTURES.find(
        (other) => other.name === fixture.openPolicy.reference,
      );
      expect(reference, `${fixture.name} names a known reference`).toBeDefined();
      expect(reference!.openPolicy.kind).toBe('hard');
      expect(reference!.unit).toBe(fixture.unit);
    }
  });
});

/** The named fixtures only, so a partial run does not report the rest missing. */
function only(...names: string[]): FloorFixture[] {
  return names.map((name) => {
    const fixture = MILKDOWN_FLOOR_FIXTURES.find((candidate) => candidate.name === name);
    if (!fixture) throw new Error(`no such fixture: ${name}`);
    return fixture;
  });
}

describe('evaluatePerformanceFloor', () => {
  it('passes a run that meets every budget', () => {
    const violations = evaluatePerformanceFloor(MILKDOWN_FLOOR_FIXTURES, [
      result({ fixture: '1k-lines', lines: 1_000, bytes: 50_000, openMs: 60 }),
      result({ fixture: '10k-lines', openMs: 500 }),
      result({ fixture: '50k-lines', lines: 50_000, bytes: 2_500_000, openMs: 2_600 }),
      result({ fixture: '1mb-adversarial', lines: 5_000, bytes: 1_048_576, openMs: 700 }),
      result({ fixture: '10mb-adversarial', lines: 50_000, bytes: 10_485_760, openMs: 7_500 }),
    ]);
    expect(violations).toEqual([]);
  });

  it('fails a hard-gated fixture that misses the open budget', () => {
    const violations = evaluatePerformanceFloor(only('10k-lines'), [
      result({ fixture: '10k-lines', openMs: PERFORMANCE_BUDGET.openMs + 1 }),
    ]);
    expect(violations).toEqual([
      { fixture: '10k-lines', kind: 'open-budget', detail: '1001ms exceeds the 1000ms budget' },
    ]);
  });

  it('does not apply the open budget above real-note sizes', () => {
    const violations = evaluatePerformanceFloor(only('10k-lines', '50k-lines'), [
      result({ fixture: '10k-lines', openMs: 500 }),
      result({ fixture: '50k-lines', lines: 50_000, bytes: 2_500_000, openMs: 2_600 }),
    ]);
    expect(violations).toEqual([]);
  });

  it('fails a linear-open fixture whose per-unit cost cliffs above its reference', () => {
    const violations = evaluatePerformanceFloor(only('10k-lines', '50k-lines'), [
      result({ fixture: '10k-lines', openMs: 500 }),
      result({ fixture: '50k-lines', lines: 50_000, bytes: 2_500_000, openMs: 30_000 }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ fixture: '50k-lines', kind: 'open-cliff' });
  });

  it('fails when a linear-open fixture has no reference measurement to compare against', () => {
    const violations = evaluatePerformanceFloor(only('50k-lines'), [
      result({ fixture: '50k-lines', lines: 50_000, bytes: 2_500_000, openMs: 2_600 }),
    ]);
    expect(violations).toEqual([
      {
        fixture: '50k-lines',
        kind: 'missing-reference',
        detail: 'no 10k-lines measurement to compare against',
      },
    ]);
  });

  it('applies the keystroke budget at every size', () => {
    const violations = evaluatePerformanceFloor(only('10mb-adversarial'), [
      result({ fixture: '10mb-adversarial', bytes: 10_485_760, keystrokeSynchronousP95Ms: 40 }),
    ]);
    expect(violations.map((v) => v.kind)).toContain('keystroke-budget');
  });

  it('fails when a fixture produced no measurement at all', () => {
    const violations = evaluatePerformanceFloor(MILKDOWN_FLOOR_FIXTURES, []);
    expect(violations.filter((v) => v.kind === 'missing-measurement')).toHaveLength(
      MILKDOWN_FLOOR_FIXTURES.length,
    );
  });
});
