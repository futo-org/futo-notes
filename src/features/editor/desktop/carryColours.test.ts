import { describe, expect, it } from 'vitest';
import { carriedColours } from './carryColours';
import type { ColourRun, Line } from './lineModel';

function line(text: string, colours: ColourRun[]): Line {
  return {
    text,
    cr: false,
    start: 0,
    byteStart: 0,
    heading: 0,
    list: null,
    quote: 0,
    divider: false,
    code: {
      first: true,
      last: true,
      digits: 2,
      language: 'js',
      name: null,
      underBlock: false,
      overBlock: false,
    },
    runs: [],
    atoms: [],
    colours,
  };
}

const run = (start: number, end: number, className: string): ColourRun => ({
  start,
  end,
  className,
});

describe('carriedColours', () => {
  const typed = line('let s = "ab";', [run(0, 3, 'k'), run(8, 12, 's'), run(12, 13, 'p')]);

  it('grows the run a letter is typed inside, and moves the ones after it', () => {
    expect(carriedColours('let s = "aXb";', typed, typed)).toEqual([
      run(0, 3, 'k'),
      run(8, 13, 's'),
      run(13, 14, 'p'),
    ]);
  });

  it('grows the run a letter is typed right after', () => {
    expect(carriedColours('letX s = "ab";', typed, typed)[0]).toEqual(run(0, 4, 'k'));
  });

  it('shrinks the run a deletion is inside, keeping it one run', () => {
    expect(carriedColours('let s = "a";', typed, typed)).toEqual([
      run(0, 3, 'k'),
      run(8, 11, 's'),
      run(11, 12, 'p'),
    ]);
  });

  it('keeps the start of a line split by Enter on the first line and its end on the last', () => {
    expect(carriedColours('let s', typed, null)).toEqual([run(0, 3, 'k')]);
    expect(carriedColours(' = "ab";', null, typed)).toEqual([run(3, 7, 's'), run(7, 8, 'p')]);
  });

  it('joins two lines: the first keeps its start, the second its end', () => {
    const above = line('a // c', [run(2, 6, 'c')]);
    const below = line('"s"', [run(0, 3, 's')]);
    expect(carriedColours('a // c"s"', above, below)).toEqual([run(2, 6, 'c'), run(6, 9, 's')]);
  });

  it('carries nothing from lines without colours', () => {
    expect(carriedColours('x', line('y', []), null)).toEqual([]);
  });
});
