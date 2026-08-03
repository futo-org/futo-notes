import { describe, expect, it } from 'vitest';

import { findDeadProbes } from './spec-gaps.mjs';

// Regression coverage for two related silent-green holes in the spec-gaps
// closure probes:
//
//   1. Nothing previously flagged a probe whose `match` regex hit zero
//      recorded gaps — 8 of the 9 probes were in that state (7 watching a
//      gap already closed and removed from docs/spec, 1 — the wikilink-tap
//      probe — born dead because docs/spec/editor.md:211 writes
//      "the **native** shells" and the bold markers broke a literal
//      "native shells" match). `findDeadProbes` is the check that would have
//      caught both classes.
//   2. The wikilink-tap probe's specific regex bug: matching literal
//      "native shells" against prose that wraps "native" in `**bold**`.

describe('findDeadProbes', () => {
  it('flags a probe whose regex matches none of the recorded gaps', () => {
    const probes = [{ match: /this text appears nowhere/, hint: 'x' }];
    const gaps = [{ file: 'a.md', line: 1, text: 'some other gap entirely' }];
    expect(findDeadProbes(probes, gaps)).toEqual(probes);
  });

  it('does not flag a probe that matches at least one recorded gap', () => {
    const probes = [{ match: /broken wikilink tap/, hint: 'x' }];
    const gaps = [{ file: 'editor.md', line: 211, text: 'no-op a broken wikilink tap' }];
    expect(findDeadProbes(probes, gaps)).toEqual([]);
  });

  it('reproduces the wikilink-tap probe being born dead by markdown bold markers', () => {
    // This is the exact shape of the pre-fix bug: the OLD regex required the
    // literal substring "native shells", but the recorded gap's prose wraps
    // just the word "native" in `**bold**` — `**native** shells` — so
    // "native shells" (contiguous) never occurs in the text.
    const oldRegex = /native shells.*no-op a broken wikilink tap/s;
    const gapText =
      'the **native** shells (iOS/Android) no-op a broken wikilink tap — the editor embed posts ' +
      '`openNote` only for a resolved link.';
    expect(
      findDeadProbes(
        [{ match: oldRegex, hint: 'x' }],
        [{ file: 'editor.md', line: 211, text: gapText }],
      ),
    ).toEqual([{ match: oldRegex, hint: 'x' }]);

    // The fixed regex drops the "native shells" prefix requirement (the
    // phrase "no-op a broken wikilink tap" is unique in docs/spec/*.md on
    // its own) and matches the same gap text.
    const fixedRegex = /no-op a broken wikilink tap/;
    expect(
      findDeadProbes(
        [{ match: fixedRegex, hint: 'x' }],
        [{ file: 'editor.md', line: 211, text: gapText }],
      ),
    ).toEqual([]);
  });
});
