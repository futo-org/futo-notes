import { expect, it } from 'vitest';
import type { Band } from './highlight';
import { joinRoundedBands, type RoundedCorners } from './joinRoundedBands';

const ROUND = { topLeft: false, topRight: false, bottomRight: false, bottomLeft: false };
const CARD = { shape: 'code-card', ...ROUND } as const;
const PICTURE = { shape: 'picture-band', ...ROUND } as const;

type Corners = Omit<RoundedCorners, 'shape'>;

/** A card 100..700 wide from `top` to `bottom`. */
function card(top: number, bottom: number): Band {
  return { left: 100, top, width: 600, height: bottom - top, rounded: CARD };
}

/** A row band from `left` to `right`, 20 tall from `top`. */
function row(left: number, right: number, top: number): Band {
  return { left, top, width: right - left, height: 20 };
}

/** A picture from `left` to `right` and `top` to `bottom`, its line's room from `reachTop` to
 *  `reachBottom`. */
function picture(
  [left, right]: [number, number],
  [top, bottom]: [number, number],
  [reachTop, reachBottom]: [number, number] = [top, bottom],
): Band {
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    rounded: PICTURE,
    reach: { top: reachTop, bottom: reachBottom },
  };
}

const cornersOf = (bands: Band[]): Corners[] =>
  joinRoundedBands(bands)
    .filter((band) => band.rounded)
    .map((band) => band.rounded!)
    .map(({ topLeft, topRight, bottomRight, bottomLeft }) => ({
      topLeft,
      topRight,
      bottomRight,
      bottomLeft,
    }));

/** The bands `joinRoundedBands` adds: the rooms it fills. */
const roomsOf = (bands: Band[]): Band[] => joinRoundedBands(bands).slice(bands.length);

it('squares a corner where the row beyond it is highlighted across it, and rounds the rest', () => {
  expect(cornersOf([row(100, 700, 0), card(20, 120), row(100, 700, 120)])).toEqual([
    { topLeft: true, topRight: true, bottomRight: true, bottomLeft: true },
  ]);
  // A band above from mid-row to the edge, one below from the edge to mid-row; rows meet at
  // fractional heights.
  expect(cornersOf([row(340, 700, 0.3), card(20.2, 120), row(100, 180, 120.4)])).toEqual([
    { topLeft: false, topRight: true, bottomRight: false, bottomLeft: true },
  ]);
});

it('rounds a card selected alone, and the facing corners of two cards a gap apart', () => {
  expect(cornersOf([card(20, 120)])).toEqual([ROUND]);
  expect(cornersOf([row(100, 700, 0), card(20, 120), card(124, 200), row(100, 700, 200)])).toEqual([
    { topLeft: true, topRight: true, bottomRight: false, bottomLeft: false },
    { topLeft: false, topRight: false, bottomRight: true, bottomLeft: true },
  ]);
  // A band that is not right against the card leaves it rounded, and fills nothing.
  expect(cornersOf([row(100, 700, 0), card(30, 120)])).toEqual([ROUND]);
  expect(roomsOf([row(100, 700, 0), card(30, 120)])).toEqual([]);
});

it('rounds a picture selected alone, whatever room its line keeps around it', () => {
  const alone = [picture([100, 300], [24, 124], [20, 148])];
  expect(cornersOf(alone)).toEqual([ROUND]);
  expect(roomsOf(alone)).toEqual([]);
});

it('fills the room between a picture and a band meeting its reach, over the width they share', () => {
  // A card above (its bottom at 20), the picture line's 4px gap, the picture; a short
  // picture beside a taller one leaves its row's room under it, to a line from mid-row on.
  const bands = [card(0, 20), picture([100, 300], [24, 84], [20, 124]), row(200, 700, 124)];
  expect(roomsOf(bands)).toEqual([
    { left: 100, top: 20, width: 200, height: 4 },
    { left: 200, top: 84, width: 100, height: 40 },
  ]);
  // The picture's top corners and the card's bottom left over its width square; its bottom
  // right, under which the line runs on, too.
  expect(cornersOf(bands)).toEqual([
    { topLeft: false, topRight: false, bottomRight: false, bottomLeft: true },
    { topLeft: true, topRight: true, bottomRight: true, bottomLeft: false },
  ]);
});

it('fills the gap between two stacked pictures once, over the width they share', () => {
  const upper = picture([100, 300], [0, 100]);
  const lower = picture([100, 200], [104, 164], [100, 164]);
  expect(roomsOf([upper, lower])).toEqual([{ left: 100, top: 100, width: 100, height: 4 }]);
  expect(cornersOf([upper, lower])).toEqual([
    { topLeft: false, topRight: false, bottomRight: false, bottomLeft: true },
    { topLeft: true, topRight: true, bottomRight: false, bottomLeft: false },
  ]);
});

it("squares a picture's corners where text on its row runs on beside it", () => {
  // Text after the picture on its row's first line unit: its top right meets it, its bottom
  // right (below the text) does not.
  expect(cornersOf([picture([100, 300], [0, 100]), row(300, 340, 0)])).toEqual([
    { topLeft: false, topRight: true, bottomRight: false, bottomLeft: false },
  ]);
});
