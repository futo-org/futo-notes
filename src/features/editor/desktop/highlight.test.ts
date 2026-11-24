// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import { drawLine } from './lineElements';
import { selectedBands } from './highlight';
import { atomElementsOf } from './atomElements';
import { loadEngineBuild } from './__test__/loadEngineBuild';

const ROW = 24;
const CARD_LEFT = 100;
const CODE_PADDING_LEFT = 40;

beforeAll(async () => {
  await loadEngineBuild();
  // jsdom measures no text: a range's box is its line's text start, under its top padding, one
  // row tall.
  Range.prototype.getClientRects = function (this: Range): DOMRectList {
    const start = this.startContainer;
    const inside = start instanceof Element ? start : start.parentElement!;
    const element = inside.closest('div')!;
    const line = element.getBoundingClientRect();
    const top = line.top + (parseFloat(element.style.paddingTop) || 0);
    const rect = new DOMRect(line.left + CODE_PADDING_LEFT, top, 8, ROW);
    return [rect] as unknown as DOMRectList;
  };
});

/** The note's lines drawn one row each, a code line's text `CODE_PADDING_LEFT` in from the
 *  card's edge: jsdom lays nothing out, so each line's box is set by hand. */
async function drawnNote(source: string): Promise<{ model: LineModel; elements: HTMLElement[] }> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const model = LineModel.from(engine.projectAll());
  engine.free();
  const elements = model.lines.map((line, index) => {
    const element = document.createElement('div');
    drawLine(element, line);
    element.style.lineHeight = `${ROW}px`;
    if (line.code) element.style.paddingLeft = `${CODE_PADDING_LEFT}px`;
    element.getBoundingClientRect = (): DOMRect => new DOMRect(CARD_LEFT, index * ROW, 600, ROW);
    return element;
  });
  document.body.replaceChildren(...elements);
  return { model, elements };
}

// Display text "above\n\na\n\nb\n\nbelow": lines 1 to 5 are code, "" at 6, "a" at 7, "" at 9,
// "b" at 10 and "" at 12.
it('keeps every band on a code line in the code column, an empty line included', async () => {
  const { model, elements } = await drawnNote('above\n```\n\na\n\nb\n\n```\nbelow');
  const origin = document.createElement('div');
  origin.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 800, 800);
  // Each selection, and the empty code line it highlights: the first, and one in the middle
  // (from it and run into). The last one's break is the block's own end: a selection holding
  // it takes the block whole.
  const ranges: Array<[start: number, end: number, emptyLine: number]> = [
    [6, 8, 1],
    [9, 11, 3],
    [7, 11, 3],
  ];
  for (const [start, end, emptyLine] of ranges) {
    const bands = selectedBands(elements, model, { start, end }, origin);
    expect(
      bands.some((band) => band.top === emptyLine * ROW),
      `${start}..${end}`,
    ).toBe(true);
    for (const band of bands)
      expect(band.left, `${start}..${end}`).toBe(CARD_LEFT + CODE_PADDING_LEFT);
  }
});

interface PictureLayout {
  pictureLine: number;
  paddingTop?: number;
  picture: { left: number; width: number; height: number };
}

const ROUND = { topLeft: false, topRight: false, bottomRight: false, bottomLeft: false };

/** `source` drawn with line `pictureLine` as tall as its top padding `paddingTop` and its
 *  picture `picture` (left, width and height; its top under the padding), the others a row
 *  each. */
async function pictureNote(
  source: string,
  { pictureLine, paddingTop = 0, picture }: PictureLayout,
): Promise<{ model: LineModel; elements: HTMLElement[] }> {
  const { model, elements } = await drawnNote(source);
  let top = 0;
  elements.forEach((element, index) => {
    const height = index === pictureLine ? paddingTop + picture.height : ROW;
    const box = new DOMRect(CARD_LEFT, top, 600, height);
    element.getBoundingClientRect = (): DOMRect => box;
    if (index === pictureLine) {
      element.style.paddingTop = `${paddingTop}px`;
      const atom = atomElementsOf(element)[0];
      const drawn = new DOMRect(picture.left, top + paddingTop, picture.width, picture.height);
      atom.getBoundingClientRect = (): DOMRect => drawn;
      atom.getClientRects = (): DOMRectList => [drawn] as unknown as DOMRectList;
    }
    top += height;
  });
  return { model, elements };
}

function bandsOf(
  { model, elements }: { model: LineModel; elements: HTMLElement[] },
  start: number,
  end: number,
): ReturnType<typeof selectedBands> {
  const origin = document.createElement('div');
  origin.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 800, 800);
  return selectedBands(elements, model, { start, end }, origin);
}

// "above" at 0, the image's spelling from 6 to 17, "below" from 18.
const PICTURE_BETWEEN = 'above\n![p](a.png)\nbelow';

it("highlights a selected picture over its own box: not its row's rest, its padding or its break", async () => {
  const note = await pictureNote(PICTURE_BETWEEN, {
    pictureLine: 1,
    paddingTop: 4,
    picture: { left: CARD_LEFT, width: 200, height: 72 },
  });
  const pictureBand = expect.objectContaining({
    left: CARD_LEFT,
    top: ROW + 4,
    width: 200,
    height: 72,
    rounded: { shape: 'picture-band', ...ROUND },
  });
  expect(bandsOf(note, 6, 17)).toEqual([pictureBand]);
  // Its line break too: nothing beside the picture.
  expect(bandsOf(note, 6, 18)).toEqual([pictureBand]);
});

it('fills the padding between a highlighted line and the picture under it, over their shared width', async () => {
  const note = await pictureNote(PICTURE_BETWEEN, {
    pictureLine: 1,
    paddingTop: 4,
    picture: { left: CARD_LEFT, width: 200, height: 72 },
  });
  // From "ab|ove": its band runs from its text (at 140) to the line's right edge.
  const bands = bandsOf(note, 2, 17);
  expect(bands).toContainEqual({ left: 140, top: ROW, width: 160, height: 4 });
  const picture = bands.find((band) => band.rounded)!;
  expect(picture.rounded).toEqual({ shape: 'picture-band', ...ROUND, topRight: true });
});

it("highlights text beside a picture on its row's first line unit only", async () => {
  const note = await pictureNote('![p](a.png)x', {
    pictureLine: 0,
    picture: { left: CARD_LEFT, width: 20, height: 72 },
  });
  // The text's box (at 140..148) is outside the 20px picture.
  const bands = bandsOf(note, 0, 12);
  expect(bands.map(({ left, top, width, height }) => [left, top, width, height])).toEqual([
    [CARD_LEFT, 0, 20, 72],
    [CARD_LEFT + CODE_PADDING_LEFT, 0, 8, ROW],
  ]);
});

it('highlights nothing beside the pictures of a picture line, the space between them included', async () => {
  // "above" at 0, the two images' spellings and the space between them from 6 to 29.
  const note = await pictureNote('above\n![a](a.png) ![b](b.png)\nbelow', {
    pictureLine: 1,
    picture: { left: CARD_LEFT, width: 20, height: 72 },
  });
  // The space's box (at 140..148) is outside the first picture; the second draws nothing here.
  expect(bandsOf(note, 6, 30).map(({ left, width }) => [left, width])).toEqual([[CARD_LEFT, 20]]);
});

/** `source`'s table rows drawn with each column 300px wide from the card's left, shifted left
 *  by `scroll` as a table scrolled sideways draws them. */
async function tableNote(
  source: string,
  scroll = 0,
): Promise<{ model: LineModel; elements: HTMLElement[] }> {
  const note = await drawnNote(source);
  for (const element of note.elements) {
    const parts = [...element.children].filter((part) => !part.classList.contains('table-pipe'));
    parts.forEach((part, column) => {
      const top = element.getBoundingClientRect().top;
      const box = new DOMRect(CARD_LEFT + column * 300 - scroll, top, 300, ROW);
      part.getBoundingClientRect = (): DOMRect => box;
    });
  }
  return note;
}

const extents = (bands: ReturnType<typeof selectedBands>): number[][] =>
  bands.map(({ left, top, width, height }) => [left, top, width, height]);

// "above" at 0; the header "| a | b |" from 6 (its cells' text at 8 and 12), the delimiter row
// from 16, "| c |  |" from 26 (c at 28, the empty cell at 31), "| d |" from 35 (d at 37, a
// filler where its second cell would be), "below" at 41.
const GRID = 'above\n| a | b |\n|---|---|\n| c |  |\n| d |\nbelow';

it('highlights every cell a selection crossing cells touches over its whole box, the delimiter row never', async () => {
  const note = await tableNote(GRID);
  // From the first cell to the empty last cell of the row under it: both rows whole.
  expect(extents(bandsOf(note, 8, 31))).toEqual([
    [CARD_LEFT, ROW, 600, ROW],
    [CARD_LEFT, 3 * ROW, 600, ROW],
  ]);
  // Two cells of one row.
  expect(extents(bandsOf(note, 8, 12))).toEqual([[CARD_LEFT, ROW, 600, ROW]]);
  // From the line above into the middle row's first cell: the header whole, that cell alone.
  const into = extents(bandsOf(note, 2, 28));
  expect(into.slice(-2)).toEqual([
    [CARD_LEFT, ROW, 600, ROW],
    [CARD_LEFT, 3 * ROW, 300, ROW],
  ]);
  // A row the selection runs past is whole, its filler included; from the second cell on.
  expect(extents(bandsOf(note, 12, 43)).slice(0, 3)).toEqual([
    [CARD_LEFT + 300, ROW, 300, ROW],
    [CARD_LEFT, 3 * ROW, 600, ROW],
    [CARD_LEFT, 4 * ROW, 600, ROW],
  ]);
});

it('keeps a selection inside one cell as text in its column, and cells to what the row shows', async () => {
  const one = await tableNote(GRID);
  // The text's own box (jsdom's range: 8px at the line's left plus 40).
  expect(extents(bandsOf(one, 8, 9))).toEqual([[CARD_LEFT + 40, ROW, 8, ROW]]);
  // Scrolled 450px: the first column is out of the row, half the second shows.
  const scrolled = await tableNote(GRID, 450);
  expect(extents(bandsOf(scrolled, 8, 12))).toEqual([[CARD_LEFT, ROW, 150, ROW]]);
});
