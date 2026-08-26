import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  createFindMatchReport,
  findCurrentMatchIndex,
  findMatches,
  wrapFindMatchIndex,
} from './findMatches';

describe('findMatches', () => {
  it('formats the canonical native count label', () => {
    expect(createFindMatchReport('missing', -1, 0)).toEqual({
      query: 'missing',
      current: 0,
      total: 0,
      label: '0',
    });
    expect(createFindMatchReport('cat', 2, 17)).toEqual({
      query: 'cat',
      current: 3,
      total: 17,
      label: '3 of 17',
    });
  });
  it('finds case-insensitive literal substrings in source markdown', () => {
    const doc = Text.of(['Cat concatenate CAT', '[label](Aug URL)']);

    expect(findMatches(doc, 'cat')).toEqual([
      { from: 0, to: 3 },
      { from: 7, to: 10 },
      { from: 16, to: 19 },
    ]);
    expect(findMatches(doc, 'aug ')).toEqual([{ from: 28, to: 32 }]);
    expect(findMatches(doc, 'dog')).toEqual([]);
  });

  it('resolves the selected match or the next match after the caret', () => {
    const matches = [
      { from: 2, to: 5 },
      { from: 10, to: 13 },
    ];

    expect(findCurrentMatchIndex(matches, { from: 10, to: 13 })).toBe(1);
    expect(findCurrentMatchIndex(matches, { from: 6, to: 6 })).toBe(1);
    expect(findCurrentMatchIndex(matches, { from: 20, to: 20 })).toBe(0);
    expect(findCurrentMatchIndex([], { from: 0, to: 0 })).toBe(-1);
  });

  it('wraps match indexes in either direction', () => {
    expect(wrapFindMatchIndex(3, 3)).toBe(0);
    expect(wrapFindMatchIndex(-1, 3)).toBe(2);
    expect(wrapFindMatchIndex(0, 0)).toBe(-1);
  });
});
