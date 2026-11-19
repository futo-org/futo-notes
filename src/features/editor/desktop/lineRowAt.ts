import { isImageAtom } from './pictureElements';

/** A line element's rows, viewport px: from its first row's top (below any top padding, a
 *  picture's gap) to its last row's bottom (above any bottom padding, a code block's skirt, the
 *  front matter's gap), `rowHeight` each, but for the rows a picture makes taller (`tall`, each
 *  its top and bottom, top to bottom). `room` is the part of the bottom padding that belongs to
 *  the last row (the room under a heading): page for a press and a key, highlighted where a
 *  selection runs past the line; the rest of the padding is page between blocks. */
export interface LineRows {
  top: number;
  bottom: number;
  rowHeight: number;
  tall: readonly (readonly [number, number])[];
  room: number;
}

/** One row of a line: its top and bottom (the last row's with its line's `room`), and the
 *  middle of its first line unit, where its text stands (a picture hangs from its row's top,
 *  desktopImages.css). */
export interface LineRow {
  index: number;
  top: number;
  bottom: number;
  middle: number;
}

/** What a line element's rows are measured with: its row height, vertical padding and the
 *  room its last row has under it (the `--row-room` its style sets, part of its bottom
 *  padding), px. */
export interface LineRowSizes {
  rowHeight: number;
  paddingTop: number;
  paddingBottom: number;
  room: number;
}

const NO_TALL_ROWS: LineRows['tall'] = [];

/** The row sizes of the line element `element` (its box `box`), from its computed style. */
export function lineRowSizesOf(element: HTMLElement, box: DOMRect): LineRowSizes {
  const style = getComputedStyle(element);
  return {
    rowHeight: parseFloat(style.lineHeight) || box.height,
    paddingTop: parseFloat(style.paddingTop) || 0,
    paddingBottom: parseFloat(style.paddingBottom) || 0,
    room: parseFloat(style.getPropertyValue('--row-room')) || 0,
  };
}

/** The rows of `element` (a line, its box `box`), each `sizes.rowHeight` but a picture's: an
 *  image's element taller than a row makes its row as tall as itself. A line without an image
 *  reads no more layout than its box. */
export function lineRows(element: HTMLElement, box: DOMRect, sizes: LineRowSizes): LineRows {
  const { rowHeight, paddingTop, paddingBottom, room } = sizes;
  let tall: [number, number][] | null = null;
  for (const child of element.children) {
    if (!isImageAtom(child)) continue;
    const picture = child.getBoundingClientRect();
    if (picture.height <= rowHeight + 0.5) continue;
    tall ??= [];
    const last = tall[tall.length - 1];
    // Pictures on one row (each hanging from its top): that row is as tall as the tallest.
    if (last && picture.top < last[1]) {
      last[0] = Math.min(last[0], picture.top);
      last[1] = Math.max(last[1], picture.bottom);
    } else tall.push([picture.top, picture.bottom]);
  }
  return {
    top: box.top + paddingTop,
    bottom: box.bottom - paddingBottom,
    rowHeight,
    tall: tall ?? NO_TALL_ROWS,
    room,
  };
}

/** The row of `rows` that viewport `y` is on: the rows are contiguous bands, so every pixel
 *  belongs to exactly one, and a `y` above the first or below the last (a margin, a gap, a
 *  skirt) belongs to the nearest. */
export function lineRowAt(rows: LineRows, y: number): LineRow {
  const { rowHeight } = rows;
  // The last row is the one no other row fits under.
  const row = (index: number, top: number, bottom: number): LineRow => ({
    index,
    top,
    bottom: bottom > rows.bottom - rowHeight / 2 ? bottom + rows.room : bottom,
    middle: top + rowHeight / 2,
  });
  // The ordinary rows from `from` to `to`, `index` the first's: the one `y` is on, nearest.
  const ordinary = (index: number, from: number, count: number): LineRow => {
    const within = Math.min(Math.max(Math.floor((y - from) / rowHeight), 0), count - 1);
    const top = from + within * rowHeight;
    return row(index + within, top, top + rowHeight);
  };
  const tall = rows.tall;
  let from = rows.top;
  let index = 0;
  for (const [top, bottom] of tall) {
    const count = Math.round((top - from) / rowHeight);
    if (count > 0 && y < top) return ordinary(index, from, count);
    index += Math.max(count, 0);
    if (y < bottom) return row(index, top, bottom);
    from = bottom;
    index++;
  }
  const count = Math.round((rows.bottom - from) / rowHeight);
  if (tall.length > 0 && count <= 0) {
    const [top, bottom] = tall[tall.length - 1];
    return row(index - 1, top, bottom);
  }
  return ordinary(index, from, Math.max(1, count));
}
