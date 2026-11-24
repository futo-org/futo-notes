// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { lineRowAt, lineRows } from './lineRowAt';

// Three rows of 24 from 100.4: a line placed at a fractional height, as a note's are.
const rows = { top: 100.4, bottom: 172.4, rowHeight: 24, tall: [] };

it('puts every pixel of a line on one row and asks at that row middle', () => {
  expect(lineRowAt(rows, 100.4)).toEqual({ index: 0, top: 100.4, bottom: 124.4, middle: 112.4 });
  expect(lineRowAt(rows, 124.3).index).toBe(0);
  expect(lineRowAt(rows, 124.4).index).toBe(1);
  expect(lineRowAt(rows, 172.3)).toEqual({ index: 2, top: 148.4, bottom: 172.4, middle: 160.4 });
});

it('gives a press above the first row or below the last (a skirt) the nearest row', () => {
  expect(lineRowAt(rows, 80).index).toBe(0);
  expect(lineRowAt(rows, 180).index).toBe(2);
  expect(lineRowAt({ top: 0, bottom: 10, rowHeight: 24, tall: [] }, 30)).toEqual({
    index: 0,
    top: 0,
    bottom: 24,
    middle: 12,
  });
});

// A row of text, a 200px picture's row, then two rows of text.
const pictured = { top: 0, bottom: 272, rowHeight: 24, tall: [[24, 224] as const] };

it('makes a picture row as tall as its picture, its text on its first line unit', () => {
  expect(lineRowAt(pictured, 10)).toEqual({ index: 0, top: 0, bottom: 24, middle: 12 });
  expect(lineRowAt(pictured, 30)).toEqual({ index: 1, top: 24, bottom: 224, middle: 36 });
  expect(lineRowAt(pictured, 223).index).toBe(1);
  expect(lineRowAt(pictured, 230)).toEqual({ index: 2, top: 224, bottom: 248, middle: 236 });
  expect(lineRowAt(pictured, 400).index).toBe(3);
});

it('ends a line on its picture row when nothing follows the picture', () => {
  const alone = { top: 0, bottom: 200, rowHeight: 24, tall: [[0, 200] as const] };
  expect(lineRowAt(alone, -5)).toEqual({ index: 0, top: 0, bottom: 200, middle: 12 });
  expect(lineRowAt(alone, 260)).toEqual({ index: 0, top: 0, bottom: 200, middle: 12 });
});

it('reads a picture taller than a row as its row, and pictures on one row as one', () => {
  const line = document.createElement('div');
  const picture = (top: number, bottom: number): HTMLElement => {
    const image = document.createElement('span');
    image.className = 'atom image';
    image.append('![](x.png)', document.createElement('img'));
    image.getBoundingClientRect = () => new DOMRect(0, top, 50, bottom - top);
    return image;
  };
  line.append('a', picture(24, 224), picture(124, 224), 'b', picture(248, 260));
  const box = new DOMRect(0, 0, 400, 284);
  const sizes = { rowHeight: 24, paddingTop: 0, paddingBottom: 0 };
  expect(lineRows(line, box, sizes).tall).toEqual([[24, 224]]);
  expect(lineRows(document.createElement('div'), box, sizes).tall).toEqual([]);
});

it('starts a line rows below its top padding and ends them above its bottom padding', () => {
  const box = new DOMRect(0, 100, 400, 36);
  const sizes = { rowHeight: 24, paddingTop: 4, paddingBottom: 8 };
  const rows = lineRows(document.createElement('div'), box, sizes);
  expect(rows).toMatchObject({ top: 104, bottom: 128 });
  // A press in either gap is on the line's one row, its text at that row's middle.
  expect(lineRowAt(rows, 101)).toEqual({ index: 0, top: 104, bottom: 128, middle: 116 });
  expect(lineRowAt(rows, 134).middle).toBe(116);
});

it('puts a gap above a picture line on its picture row', () => {
  // A 4px gap, then a 200px picture from the row's top.
  const gapped = { top: 4, bottom: 204, rowHeight: 24, tall: [[4, 204] as const] };
  expect(lineRowAt(gapped, 1)).toEqual({ index: 0, top: 4, bottom: 204, middle: 16 });
  expect(lineRowAt(gapped, 200).index).toBe(0);
});
