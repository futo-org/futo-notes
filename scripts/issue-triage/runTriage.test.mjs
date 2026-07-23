import { describe, expect, it } from 'vitest';

import { formatOutcome, selectIssue } from './runTriage.mjs';

describe('selectIssue', () => {
  const state = {
    issues: {
      3: { status: 'posted', classifiedAs: 'feature' },
      8: { status: 'queued', classifiedAs: 'bug' },
      12: { status: 'queued', classifiedAs: 'bug' },
    },
  };

  it('picks the oldest queued bug by number', () => {
    expect(selectIssue(state)?.number).toBe('8');
  });

  it('returns null when nothing is queued', () => {
    expect(selectIssue({ issues: { 3: { status: 'posted' } } })).toBeNull();
  });

  it('honors an explicit issue number', () => {
    expect(selectIssue(state, '12')?.number).toBe('12');
  });

  it('throws for an unknown explicit issue', () => {
    expect(() => selectIssue(state, '999')).toThrow(/not in the triage state/);
  });
});

describe('formatOutcome', () => {
  it('reports needs_human when the agent produced no result', () => {
    const content = formatOutcome({ number: '8', result: null });
    expect(content).toContain('needs a human');
    expect(content).toContain('gh#8');
  });

  it('surfaces the MR link and high-stakes warning on a fix', () => {
    const content = formatOutcome({
      number: '8',
      result: {
        outcome: 'reproduced_fixed',
        platform: 'android',
        mrUrl: 'https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/99',
        highStakes: true,
        summary: 'Fixed the dark-mode text color.',
        attemptedSteps: 'android emulator, assembleDebug',
      },
    });
    expect(content).toContain('Reproduced and fixed');
    expect(content).toContain('merge_requests/99');
    expect(content).toContain('High-stakes');
    expect(content).toContain('Fixed the dark-mode text color.');
  });

  it('falls back to needs_human for an unknown outcome value', () => {
    const content = formatOutcome({ number: '8', result: { outcome: 'weird', summary: 'x' } });
    expect(content).toContain('Needs a human');
  });
});
