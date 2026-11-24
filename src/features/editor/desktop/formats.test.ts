import { describe, expect, it } from 'vitest';
import type { InlineFormat } from '@futo-notes/editor/wasm-payloads';

import {
  arrivalAffinity,
  codeEdge,
  edgeAffinity,
  flagMarks,
  formatButtons,
  selectsText,
} from './formats';
import type { Line } from './lineModel';

const BLOCKS = { heading: 0, headingAllowed: true, quote: false, quoteAllowed: true };

/** A line at UTF-16 `start` holding `text`, with runs `[start, end, formats]`. */
function line(
  text: string,
  runs: Array<[number, number, InlineFormat[]]> = [],
  start = 0,
  heading = 0,
): Line {
  return {
    text,
    cr: false,
    start,
    byteStart: start,
    heading,
    list: null,
    quote: 0,
    divider: false,
    runs: runs.map(([from, to, formats]) => ({ start: from, end: to, formats })),
    atoms: [],
    links: [],
  };
}

describe('arrivalAffinity', () => {
  // "ab" plain, "cd" bold, "ef" plain.
  const bold = line('abcdef', [[2, 4, ['Bold']]]);
  const passed = (forward: boolean) => ({ kind: 'passed', forward }) as const;
  const landed = { kind: 'landed' } as const;

  it('takes the side of the character the caret passed, whichever way it came', () => {
    for (const at of [2, 4]) {
      expect(arrivalAffinity(bold, at, passed(true), 'cameFrom')).toBe('Backward');
      expect(arrivalAffinity(bold, at, passed(false), 'cameFrom')).toBe('Forward');
    }
    // Onto a line's start from the line above: the line break, no formats.
    expect(arrivalAffinity(bold, 0, passed(true), 'cameFrom')).toBe('Backward');
  });

  it('lands with the character before, at the text start with the first one', () => {
    expect(arrivalAffinity(bold, 4, landed, 'cameFrom')).toBe('Backward');
    expect(arrivalAffinity(bold, 0, landed, 'cameFrom')).toBe('Forward');
    const item = line('\uFFFCab', [[1, 3, ['Code']]]);
    const listItem: Line = {
      ...item,
      atoms: [{ kind: 'ListMarker', start: 0, end: 1, image: null }],
    };
    expect(arrivalAffinity(listItem, 1, landed, 'cameFrom')).toBe('Forward');
  });

  it('keeps a pressed side, and a stepped one under every rule', () => {
    const pressed = { kind: 'pressed', side: 'Forward' } as const;
    const stepped = { kind: 'stepped', side: 'Backward' } as const;
    expect(arrivalAffinity(bold, 4, pressed, 'cameFrom')).toBe('Forward');
    expect(arrivalAffinity(bold, 4, pressed, 'left')).toBe('Backward');
    expect(arrivalAffinity(bold, 2, stepped, 'right')).toBe('Backward');
  });

  it('leaves every other arrival to the older rules', () => {
    expect(arrivalAffinity(bold, 2, passed(true), 'more')).toBe('Forward');
    expect(arrivalAffinity(bold, 4, passed(false), 'left')).toBe('Backward');
  });
  it('stands outside a link at its edges by any arrival and rule but a step', () => {
    // "cd" is a link's label.
    const linked: Line = { ...line('abcdef'), links: [{ start: 2, end: 4, destination: 'u' }] };
    expect(arrivalAffinity(linked, 4, passed(true), 'cameFrom')).toBe('Forward');
    expect(arrivalAffinity(linked, 2, passed(false), 'cameFrom')).toBe('Backward');
    expect(arrivalAffinity(linked, 4, landed, 'left')).toBe('Forward');
    expect(arrivalAffinity(linked, 3, passed(true), 'cameFrom')).toBe('Backward');
    const stepped = { kind: 'stepped', side: 'Backward' } as const;
    expect(arrivalAffinity(linked, 4, stepped, 'cameFrom')).toBe('Backward');
  });
});

describe('codeEdge', () => {
  // "ab" plain, "cd" code, "ef" bold; then a line that is all code.
  const mixed = line('abcdef', [
    [2, 4, ['Code']],
    [4, 6, ['Bold']],
  ]);
  const whole = line('code', [[0, 4, ['Code']]]);

  it("finds where code starts and ends, a line's ends included", () => {
    expect(codeEdge(mixed, 2)).toEqual({ codeBefore: false });
    expect(codeEdge(mixed, 4)).toEqual({ codeBefore: true });
    expect(codeEdge(whole, 0)).toEqual({ codeBefore: false });
    expect(codeEdge(whole, 4)).toEqual({ codeBefore: true });
  });

  it('is no edge inside code, in plain text or between other formats', () => {
    for (const at of [0, 1, 3, 5, 6]) expect(codeEdge(mixed, at)).toBeNull();
    expect(codeEdge(whole, 2)).toBeNull();
  });
});

describe('edgeAffinity', () => {
  // "ab" plain, "cd" bold, "ef" bold italic, "gh" italic.
  const mixed = line('abcdefgh', [
    [2, 4, ['Bold']],
    [4, 6, ['Bold', 'Italic']],
    [6, 8, ['Italic']],
  ]);

  it('joins the side with more formatting, the left one on a tie', () => {
    expect(edgeAffinity(mixed, 2, 'more')).toBe('Forward');
    expect(edgeAffinity(mixed, 4, 'more')).toBe('Forward');
    expect(edgeAffinity(mixed, 6, 'more')).toBe('Backward');
    expect(edgeAffinity(mixed, 8, 'more')).toBe('Backward');
    expect(
      edgeAffinity(
        line('abcd', [
          [0, 2, ['Bold']],
          [2, 4, ['Italic']],
        ]),
        2,
        'more',
      ),
    ).toBe('Backward');
  });

  it('takes the first character at a line start, whatever the rule', () => {
    for (const rule of ['more', 'left', 'right'] as const) {
      expect(edgeAffinity(mixed, 0, rule)).toBe('Forward');
    }
  });

  it('always left or always right under those rules', () => {
    expect(edgeAffinity(mixed, 2, 'left')).toBe('Backward');
    expect(edgeAffinity(mixed, 6, 'right')).toBe('Forward');
  });
});

describe('selectsText', () => {
  const lines = [line('bold ital'), line('', [], 10), line('   ', [], 11)];

  it('finds a selected character that is not whitespace, across lines', () => {
    expect(selectsText(lines, 0, 4, 6)).toBe(true);
    expect(selectsText(lines, 0, 8, 14)).toBe(true);
  });

  it('says when the selection holds only whitespace and line breaks', () => {
    expect(selectsText(lines, 0, 4, 5)).toBe(false);
    expect(selectsText(lines, 1, 10, 14)).toBe(false);
  });

  it("does not count a list marker's or a divider's one character", () => {
    const item = [line('\uFFFCmilk')];
    expect(selectsText(item, 0, 0, 1)).toBe(false);
    expect(selectsText(item, 0, 0, 2)).toBe(true);
  });

  it("does not count a picture's spelling, but counts text beside it", () => {
    const spelling = '![cat](cat.png)';
    const image = { alt: 'cat', destination: 'cat.png', title: null, reference: null, vault: true };
    const picture: Line = {
      ...line(`${spelling} hi`),
      atoms: [{ kind: 'Image', start: 0, end: spelling.length, image }],
    };
    expect(selectsText([picture], 0, 0, spelling.length)).toBe(false);
    expect(selectsText([picture], 0, 0, spelling.length + 3)).toBe(true);
  });
});

describe('toolbar buttons and the flag', () => {
  it('lights what the text has and disables what the engine leaves out of allowed', () => {
    const selected = { formats: ['Code'], text: true, allowed: ['Code', 'Link'] } as const;
    expect(formatButtons({ ...selected, blocks: BLOCKS })).toEqual([
      { format: 'Bold', lit: false, disabled: true },
      { format: 'Italic', lit: false, disabled: true },
      { format: 'Strike', lit: false, disabled: true },
      { format: 'Code', lit: true, disabled: false },
    ]);
  });

  it('marks the heading level, then the formats in toolbar order', () => {
    expect(flagMarks(['Code', 'Bold'], 2)).toEqual(['H2', 'B', '<>']);
    expect(flagMarks([], 0)).toEqual([]);
  });
});
