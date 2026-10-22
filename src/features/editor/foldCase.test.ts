import { describe, expect, it } from 'vitest';

import { foldCase, foldCaseWithOffsets } from './foldCase';

describe('foldCase', () => {
  it('lowercases ordinary text', () => {
    expect(foldCase('CaT')).toBe('cat');
  });

  it('allows expanding lowercase characters for substring matching', () => {
    expect(foldCase('\u0130stanbul')).toBe('i\u0307stanbul');
  });

  it('preserves find offsets when a lowercase character is longer', () => {
    expect(foldCaseWithOffsets('a\u0130b')).toBe('a\u0130b');
    expect(foldCaseWithOffsets('a\u0130b')).toHaveLength(3);
  });

  // toLowerCase writes a capital sigma as final ς with no letter after it and
  // as σ before one, so one letter folded two ways depending on what follows.
  it('folds every sigma to one letter, whatever follows it', () => {
    expect(foldCase('ΟΔΟΣ')).toBe(foldCase('ΟΔΟΣΑ').slice(0, 4));
    expect(foldCase('οδος')).toBe(foldCase('οδοσ'));
    expect(foldCaseWithOffsets('\u0130ΟΔΟΣ')).toBe('\u0130οδοσ');
  });
});
