import { describe, expect, it } from 'vitest';

import {
  ALERT_THROTTLE_MS,
  HOLD_LABEL,
  formatCommentDm,
  parseResult,
  selectMrs,
  shouldAlert,
} from './rules.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function mr(iid, overrides = {}) {
  return {
    iid,
    sha: SHA_A,
    draft: false,
    target_branch: 'main',
    author: { username: 'justin' },
    labels: [],
    ...overrides,
  };
}

describe('selectMrs', () => {
  it('skips MRs the factory must not QA or merge', () => {
    const open = [
      mr(1, { draft: true }),
      mr(2, { author: { username: 'outside-contributor' } }),
      mr(3, { labels: [HOLD_LABEL] }),
      mr(4, { target_branch: 'editor-hillclimb-faster' }),
      mr(5),
    ];
    expect(selectMrs(open, { mrs: {} }).map((m) => m.iid)).toEqual([5]);
  });

  it("waits for Justin's approval on Mason's MRs", () => {
    const open = [
      mr(1, { author: { username: 'mason' } }),
      mr(2, { author: { username: 'mason' } }),
    ];
    const approvers = new Map([
      [1, ['justin']],
      [2, ['mason']],
    ]);
    expect(selectMrs(open, { mrs: {} }, approvers).map((m) => m.iid)).toEqual([1]);
    expect(selectMrs(open, { mrs: {} }).map((m) => m.iid)).toEqual([]);
  });

  it('judges a head commit once, and again after a new push', () => {
    const state = { mrs: { 7: { sha: SHA_A, verdict: 'no_ship' } } };
    expect(selectMrs([mr(7)], state)).toEqual([]);
    expect(selectMrs([mr(7, { sha: SHA_B })], state).map((m) => m.iid)).toEqual([7]);
  });

  it('takes the oldest five', () => {
    const open = [9, 3, 8, 1, 7, 2, 6].map((iid) => mr(iid));
    expect(selectMrs(open, { mrs: {} }).map((m) => m.iid)).toEqual([1, 2, 3, 6, 7]);
  });
});

describe('parseResult', () => {
  it('trusts only well-formed verdicts for the MRs it was given', () => {
    const raw = JSON.stringify({
      mrs: [
        { iid: 1, verdict: 'merged', comment: null },
        { iid: 2, verdict: 'no_ship', comment: 'iOS leg fails' },
        { iid: 3, verdict: 'no_ship', comment: '' },
        { iid: 4, verdict: 'merged', comment: 'merged but chatty' },
        { iid: 5, verdict: 'shipped', comment: null },
        { iid: 6, verdict: 'merged', comment: null },
        { iid: 6, verdict: 'no_ship', comment: 'contradicts itself' },
        { iid: 99, verdict: 'merged', comment: null },
      ],
      problems: ['Codex could not run: auth expired', ''],
      summary: 'one merged',
    });
    const result = parseResult(raw, [1, 2, 3, 4, 5, 6, 7]);
    expect([...result.verdicts.keys()]).toEqual([1, 2]);
    expect(result.missing).toEqual([3, 4, 5, 6, 7]);
    expect(result.problems).toEqual(['Codex could not run: auth expired']);
  });

  it('rejects a file that is not a result', () => {
    expect(parseResult('not json', [1])).toBeNull();
    expect(parseResult('{"summary":"no mrs array"}', [1])).toBeNull();
  });
});

it('formats the author DM exactly as specified', () => {
  expect(
    formatCommentDm({
      iid: 333,
      webUrl: 'https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/333',
      noteId: 9,
    }),
  ).toBe(
    'left a comment on [!333](https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/333#note_9)',
  );
});

it('alerts on the first failure, then at most once per throttle window', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  expect(shouldAlert({}, now)).toBe(true);
  expect(shouldAlert({ lastAlertAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
  expect(shouldAlert({ lastAlertAt: new Date(now - ALERT_THROTTLE_MS).toISOString() }, now)).toBe(
    true,
  );
  expect(shouldAlert({ lastAlertAt: 'garbage' }, now)).toBe(true);
});
