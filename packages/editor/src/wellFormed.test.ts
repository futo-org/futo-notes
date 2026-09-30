import { afterEach, describe, expect, it } from 'vitest';

import { hasLoneSurrogate, toWellFormedDeep, toWellFormedText } from './wellFormed';

const HIGH = '\ud83d';
const LOW = '\ude00';
const EMOJI = HIGH + LOW;

const restore: Array<() => void> = [];

describe.each([
  ['native toWellFormed', () => {}],
  [
    'the scan fallback',
    () => {
      const proto = String.prototype as { toWellFormed?: unknown };
      const original = proto.toWellFormed;
      Object.defineProperty(proto, 'toWellFormed', { value: undefined, configurable: true });
      restore.push(() =>
        Object.defineProperty(proto, 'toWellFormed', { value: original, configurable: true }),
      );
    },
  ],
])('toWellFormedText (%s)', (_name, setup) => {
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  it('writes a lone high surrogate as U+FFFD', () => {
    setup();
    expect(toWellFormedText('\ud800')).toBe('\uFFFD');
    expect(toWellFormedText(`a${HIGH}b`)).toBe('a\uFFFDb');
  });

  it('writes a lone low surrogate as U+FFFD', () => {
    setup();
    expect(toWellFormedText('a\udc00b')).toBe('a\uFFFDb');
    expect(toWellFormedText(LOW)).toBe('\uFFFD');
  });

  it('keeps a valid pair, whatever surrounds it', () => {
    setup();
    expect(toWellFormedText(`x${EMOJI}y`)).toBe(`x${EMOJI}y`);
    expect(toWellFormedText(EMOJI + EMOJI)).toBe(EMOJI + EMOJI);
  });

  it('repairs each half of a split pair independently', () => {
    setup();
    // high, high, low: the first is lone, the second pairs with the low
    expect(toWellFormedText(HIGH + EMOJI)).toBe('\uFFFD' + EMOJI);
    // low, high: reversed order is two lone surrogates
    expect(toWellFormedText(LOW + HIGH)).toBe('\uFFFD\uFFFD');
    expect(toWellFormedText(EMOJI + LOW + HIGH)).toBe(EMOJI + '\uFFFD\uFFFD');
  });

  it('handles a trailing high surrogate and the empty string', () => {
    setup();
    expect(toWellFormedText(`end${HIGH}`)).toBe('end\uFFFD');
    expect(toWellFormedText('')).toBe('');
  });

  it('returns the very same string when nothing needs repair', () => {
    setup();
    const text = `plain ${EMOJI} text\n`;
    expect(toWellFormedText(text)).toBe(text);
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(hasLoneSurrogate(`a${HIGH}`)).toBe(true);
  });

  it('is linear on a large document with many surrogates', () => {
    setup();
    const big = (EMOJI + HIGH + 'x').repeat(50_000);
    const fixed = toWellFormedText(big);
    expect(fixed).toBe((EMOJI + '\uFFFD' + 'x').repeat(50_000));
  });
});

describe('toWellFormedDeep', () => {
  it('repairs strings in arrays and objects, keys included', () => {
    const input = { id: `a${HIGH}b`, list: ['ok', LOW], nested: { [`k${HIGH}`]: 1, n: 2 } };
    expect(toWellFormedDeep(input)).toEqual({
      id: 'a\uFFFDb',
      list: ['ok', '\uFFFD'],
      nested: { 'k\uFFFD': 1, n: 2 },
    });
  });

  it('returns the same object when nothing needed repair', () => {
    const input = { id: 'a', list: ['b', EMOJI], nested: { n: 1, flag: true, none: null } };
    expect(toWellFormedDeep(input)).toBe(input);
  });

  it('leaves the original untouched and keeps key order', () => {
    const input = { a: 1, b: `x${HIGH}`, c: 3 };
    const fixed = toWellFormedDeep(input);
    expect(input.b).toBe(`x${HIGH}`);
    expect(Object.keys(fixed)).toEqual(['a', 'b', 'c']);
  });

  it('passes bytes, non-plain objects and primitives through', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toWellFormedDeep(bytes)).toBe(bytes);
    expect(toWellFormedDeep(undefined)).toBeUndefined();
    expect(toWellFormedDeep(7)).toBe(7);
    const date = new Date(0);
    expect(toWellFormedDeep({ date }).date).toBe(date);
  });
});
