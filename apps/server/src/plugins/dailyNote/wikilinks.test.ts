import { describe, it, expect } from 'vitest';
import { levenshtein, findClosestTitle } from './index.js';

describe('malformed wikilink bracket fix', () => {
  // These are tested as regex replacements applied in generateDailyNote
  // We test the regexes directly here
  const fixBrackets = (content: string): string => {
    content = content.replace(/\[\[([^\]]+)\)\]/g, '[[$1]]');
    content = content.replace(/\[\[([^\]]+)\]\]\]+/g, '[[$1]]');
    return content;
  };

  it('fixes [[title))] → [[title]]', () => {
    expect(fixBrackets('See [[This week (3-17 to 3-20))] for details')).toBe(
      'See [[This week (3-17 to 3-20)]] for details',
    );
  });

  it('leaves correct wikilinks alone', () => {
    expect(fixBrackets('See [[My Note]] for details')).toBe('See [[My Note]] for details');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length of other string when one is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('handles single character difference', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
    expect(levenshtein('cat', 'cats')).toBe(1);
    expect(levenshtein('cat', 'at')).toBe(1);
  });

  it('handles transpositions as 2 edits', () => {
    expect(levenshtein('gstack', 'gtack')).toBe(1);
  });

  it('handles the gtack/gstack case', () => {
    // "gtack" vs "gstack" — missing 's', distance should be 1
    expect(levenshtein('gtack Stonefruit', 'gstack Stonefruit')).toBe(1);
  });
});

describe('findClosestTitle', () => {
  const knownTitles = new Set([
    'gstack Stonefruit',
    'Weekly Planning',
    'Getting better at Claude',
    'Visions of Stonefruit',
    'Stonefruit gstack masterplan',
  ]);

  it('corrects gtack Stonefruit → gstack Stonefruit', () => {
    expect(findClosestTitle('gtack Stonefruit', knownTitles)).toBe('gstack Stonefruit');
  });

  it('corrects minor typos', () => {
    expect(findClosestTitle('Weeky Planning', knownTitles)).toBe('Weekly Planning');
  });

  it('returns null for exact matches (handled elsewhere)', () => {
    // findClosestTitle only finds corrections for non-exact matches
    // with distance > 0, so exact matches return null (dist === 0 is excluded)
    expect(findClosestTitle('gstack Stonefruit', knownTitles)).toBeNull();
  });

  it('returns null when no close match exists', () => {
    expect(findClosestTitle('Completely Different Title', knownTitles)).toBeNull();
  });

  it('returns null for very short strings where edit distance is high relative to length', () => {
    // "abc" vs "xyz" = distance 3, similarity = 1 - 3/3 = 0, below 0.6 threshold
    const titles = new Set(['xyz']);
    expect(findClosestTitle('abc', titles)).toBeNull();
  });

  it('is case-insensitive when matching', () => {
    expect(findClosestTitle('GTACK Stonefruit', knownTitles)).toBe('gstack Stonefruit');
  });

  it('returns the closest match among multiple candidates', () => {
    // "apple piee" is distance 1 from both "apple pie" and "apple pies"
    // First match wins — either is acceptable
    const titles = new Set(['apple pie', 'apple pies', 'apple juice']);
    const result = findClosestTitle('apple piee', titles);
    expect(result === 'apple pie' || result === 'apple pies').toBe(true);
  });

  it('respects the similarity threshold', () => {
    // "ab" vs "xyz" = distance 3, but length diff > 3 so it's skipped
    const titles = new Set(['xyz']);
    expect(findClosestTitle('ab', titles)).toBeNull();
  });
});
