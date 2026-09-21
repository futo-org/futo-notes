import { describe, expect, it } from 'vitest';

import {
  LOST_TOKEN_SAMPLE_LIMIT,
  collectLostTokenSamples,
  detectTextLoss,
  textTokens,
} from './lossOracle';

describe('textTokens', () => {
  it('drops block markers so a bullet style change is not loss', () => {
    expect(textTokens('- alpha')).toEqual(textTokens('* alpha'));
    expect(textTokens('1. alpha')).toEqual(textTokens('1) alpha'));
    expect(textTokens('> quoted words')).toEqual(textTokens('quoted words'));
    expect(textTokens('## heading here')).toEqual(textTokens('heading here'));
  });

  it('drops inline emphasis and code markers', () => {
    expect(textTokens('__alpha__')).toEqual(textTokens('**alpha**'));
    expect(textTokens('`alpha`')).toEqual(['alpha']);
  });

  it('undoes backslash escapes so escaping is not loss', () => {
    expect(textTokens('\\[\\[Project/Roadmap]]')).toEqual(textTokens('[[Project/Roadmap]]'));
  });

  it('drops tokens that carry no letter or digit', () => {
    expect(textTokens('| --- | :-: |')).toEqual([]);
    expect(textTokens('---')).toEqual([]);
  });

  it('treats an autolink and its bare URL as the same token', () => {
    expect(textTokens('<https://example.test/a>')).toEqual(['https://example.test/a']);
  });

  it('keeps digits that are not a list marker', () => {
    expect(textTokens('the answer is 42')).toContain('42');
  });
});

describe('detectTextLoss', () => {
  it('reports nothing when normalization only rewrites syntax', () => {
    const before = '- __alpha__ and [[Link]]\n- beta\n';
    const after = '* **alpha** and \\[\\[Link]]\n* beta\n';
    expect(detectTextLoss(before, after).lostTokens).toEqual([]);
  });

  it('reports the fused words when a <br> is deleted', () => {
    const before = '| a |\n| --- |\n| sentence one.<br>sentence two. |\n';
    const after = '| a |\n| --- |\n| sentence one.sentence two. |\n';
    const loss = detectTextLoss(before, after);
    expect(loss.lostTokens).toContain('sentence');
    expect(loss.lostTokens).toContain('one.');
    expect(loss.lostTokens).toContain('br');
  });

  it('reports an empty-text link that was deleted href and all', () => {
    const before = 'see [](https://example.test/gone) here\n';
    const after = 'see  here\n';
    expect(detectTextLoss(before, after).lostTokens).toEqual(['https://example.test/gone']);
  });

  it('does not report added content as loss', () => {
    const before = '* 0. item\n';
    const after = '* 0\\.<br />item\n';
    expect(detectTextLoss(before, after).lostTokens).toEqual([]);
  });

  it('counts a repeated token as lost only when a copy actually disappears', () => {
    expect(detectTextLoss('a a a', 'a a a').lostTokens).toEqual([]);
    expect(detectTextLoss('a a a', 'a a').lostTokens).toEqual(['a']);
    expect(detectTextLoss('a a a', 'a a').lostTokenCount).toBe(1);
  });

  it('lets one token absorb the character the sweep inserted', () => {
    const before = '- item one\n';
    const after = '- xitem one\n';
    expect(detectTextLoss(before, after).lostTokens).toEqual(['item']);
    expect(detectTextLoss(before, after, { absorbable: 'x' }).lostTokens).toEqual([]);
  });

  it('lets the inserted character be absorbed only once', () => {
    const before = 'item item\n';
    const after = 'xitem xitem\n';
    expect(detectTextLoss(before, after, { absorbable: 'x' }).lostTokens).toEqual(['item']);
  });
});

describe('collectLostTokenSamples', () => {
  it('de-duplicates and caps, so a corpus-wide run stays readable', () => {
    const samples: string[] = [];
    collectLostTokenSamples(samples, ['a', 'b', 'a']);
    collectLostTokenSamples(samples, ['b', 'c']);
    expect(samples).toEqual(['a', 'b', 'c']);

    collectLostTokenSamples(
      samples,
      Array.from({ length: 200 }, (_, index) => `word-${index}`),
    );
    expect(samples).toHaveLength(LOST_TOKEN_SAMPLE_LIMIT);
  });
});

describe('detectTextLoss options', () => {
  it('refuses an absorbable that is not exactly one character', () => {
    expect(() => detectTextLoss('a', 'a', { absorbable: 'xy' })).toThrow(/one character/);
  });
});
