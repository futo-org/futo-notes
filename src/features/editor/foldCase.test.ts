import { describe, expect, it } from 'vitest';

import { foldCase } from './foldCase';

describe('foldCase', () => {
  it('lowercases ordinary text', () => {
    expect(foldCase('CaT')).toBe('cat');
  });

  // 'İ' lowercases to two code units, which would shift every offset after it.
  it('leaves a character whose lowercase is longer exactly as it was', () => {
    const grows = 'İ';
    expect(grows.toLowerCase().length).toBe(2);
    expect(foldCase(`a${grows}b`)).toBe(`a${grows}b`);
    expect(foldCase(`a${grows}b`)).toHaveLength(3);
  });

  // toLowerCase writes a capital sigma as final ς with no letter after it and
  // as σ before one, so one letter folded two ways depending on what follows.
  it('folds every sigma to one letter, whatever follows it', () => {
    expect(foldCase('ΟΔΟΣ')).toBe(foldCase('ΟΔΟΣΑ').slice(0, 4));
    expect(foldCase('οδος')).toBe(foldCase('οδοσ'));
  });
});
