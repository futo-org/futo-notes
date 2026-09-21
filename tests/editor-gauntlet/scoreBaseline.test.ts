import { describe, expect, it } from 'vitest';

import { compareToBaseline, type CaseOutcome } from './scoreBaseline';

const baseline = { expectedFailures: { 'wikilink/enter': 'no wikilink node yet' } };

function outcome(id: string, ok: boolean): CaseOutcome {
  return { id, ok, failures: ok ? [] : [`${id} lost its mark`] };
}

describe('compareToBaseline', () => {
  it('accepts a run that matches the ledger exactly', () => {
    expect(
      compareToBaseline(baseline, [outcome('wikilink/enter', false), outcome('bold/enter', true)]),
    ).toEqual({ regressions: [], staleEntries: [] });
  });

  it('reports a case that newly fails, with its reasons', () => {
    expect(compareToBaseline(baseline, [outcome('bold/enter', false)]).regressions).toEqual([
      { id: 'bold/enter', failures: ['bold/enter lost its mark'] },
    ]);
  });

  it('reports a ledger entry whose case now passes', () => {
    expect(compareToBaseline(baseline, [outcome('wikilink/enter', true)]).staleEntries).toEqual([
      'wikilink/enter',
    ]);
  });
});
