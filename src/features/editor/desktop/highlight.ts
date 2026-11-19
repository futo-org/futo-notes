/* The selection's highlight, drawn by the editor (the native one is transparent, the native
 * selection stays): one band per selected row, row tall, so wrapped rows and blank lines
 * read as one block. A row the selection runs past, a selected line break included, reaches
 * the text column's right edge, as AppKit draws it, and a row it runs into starts at the
 * line's left edge. Only the lines on screen, and a screen either side, are drawn: a
 * selection of a whole long note costs what one screen does. Over code blocks the bands keep to
 * the code's column, or fill a block's card (codeBlockSelection.ts). The room under a heading
 * is highlighted where the selection runs on past the heading (lineRowAt.ts). A selected picture is
 * highlighted over its own box, text on its row over the row's first line unit, never the rest
 * of the row; cards and pictures join the bands they meet (joinRoundedBands.ts). In a table, a
 * selection inside one cell is highlighted in that cell's column; one crossing cells covers
 * each cell it touches whole, its row's height (tableRowElements.ts `tableRowHighlight`). */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { LineModel } from './lineModel';
import { pointInLine, withMeasuringRange } from './lineElements';
import { atomElementsOf } from './atomElements';
import {
  lineRowAt,
  lineRowSizesOf,
  lineRows,
  type LineRow,
  type LineRowSizes,
  type LineRows,
} from './lineRowAt';
import {
  cardBand,
  codeBlockLinesAt,
  codeColumnOf,
  isBlockTakenWhole,
  type CodeBlockLines,
} from './codeBlockSelection';
import { joinRoundedBands, type RoundedCorners } from './joinRoundedBands';
import { tableRowHighlight } from './tableRowElements';
import { isPictureLine } from './blockNeighbours';

/** A highlight band relative to the editor's wrapper, viewport px; `rounded` when it fills a
 *  code block's card or a selected picture, rounded as those are but where it says a corner is
 *  square. A picture's `reach` is its row, and its line's padding on the line's first or last
 *  row: the room a band meeting it fills (joinRoundedBands.ts). */
export interface Band {
  left: number;
  top: number;
  width: number;
  height: number;
  rounded?: RoundedCorners;
  reach?: { top: number; bottom: number };
}

/** A pixel either way: a picture's box and a range's boxes inside it meet at fractional
 *  pixels. */
const PICTURE_TOLERANCE = 1;

const ROUND_PICTURE: RoundedCorners = {
  shape: 'picture-band',
  topLeft: false,
  topRight: false,
  bottomRight: false,
  bottomLeft: false,
};

function isInside(rect: DOMRect, box: DOMRect): boolean {
  return (
    rect.left >= box.left - PICTURE_TOLERANCE &&
    rect.right <= box.right + PICTURE_TOLERANCE &&
    rect.top >= box.top - PICTURE_TOLERANCE &&
    rect.bottom <= box.bottom + PICTURE_TOLERANCE
  );
}

/** The index of the first of `elements` whose bottom is below `y` (viewport px). */
export function firstBelow(elements: readonly HTMLElement[], y: number): number {
  let low = 0;
  let high = elements.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (elements[middle].getBoundingClientRect().bottom <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The height of a text band on row `drawn` of `rows`: text stands on a row's first line unit,
 *  the rest of a picture's row being the picture's. The room under a line's last row (a
 *  heading's) is the row's where the selection `runsOn` past it, so the band meets the next
 *  line's. */
function textBandHeight(drawn: LineRow, rows: LineRows, runsOn: boolean): number {
  const room = drawn.bottom > rows.bottom ? rows.room : 0;
  const rowSpan = drawn.bottom - room - drawn.top;
  // Half a pixel either way: rows meet at fractional heights.
  const isTextRow = rowSpan <= rows.rowHeight + 0.5;
  return Math.min(rowSpan, rows.rowHeight) + (runsOn && isTextRow ? room : 0);
}

/** `rect` (viewport px) as a band relative to `base`. */
function bandOf(rect: DOMRect, base: DOMRect): Band {
  return {
    left: rect.left - base.left,
    top: rect.top - base.top,
    width: rect.width,
    height: rect.height,
  };
}

/** The bands of `range` (UTF-16 display offsets) on the lines near the screen, relative
 *  to `origin`; with `selectedBlock`, the code block selected as one object, its card. */
export function selectedBands(
  elements: readonly HTMLElement[],
  model: LineModel,
  range: DisplayRange,
  origin: HTMLElement,
  selectedBlock: DisplayRange | null = null,
): Band[] {
  if (elements.length === 0) return [];
  const base = origin.getBoundingClientRect();
  if (selectedBlock) {
    const block = codeBlockLinesAt(model.lines, model.lineAt(selectedBlock.start));
    return [cardBand(elements, block, base)];
  }
  if (range.start === range.end) return [];
  const screen = window.innerHeight;
  const first = Math.max(model.lineAt(range.start), firstBelow(elements, -screen));
  const last = Math.min(model.lineAt(range.end), firstBelow(elements, 2 * screen));
  const rowSizes = new Map<string, LineRowSizes>();
  const bands: Band[] = [];
  // The code block the lines are in, and whether the selection takes it whole.
  let block: CodeBlockLines | null = null;
  let whole = false;
  withMeasuringRange((span) => {
    for (let index = first; index <= last && index < elements.length; index++) {
      const element = elements[index];
      const line = model.lines[index];
      // A table's delimiter row is never drawn.
      if (line.table?.role === 'delimiter') continue;
      if (line.code && (!block || index > block.last)) {
        block = codeBlockLinesAt(model.lines, index);
        whole = isBlockTakenWhole(range, block, model.length);
        if (whole) bands.push(cardBand(elements, block, base));
      }
      if (line.code && whole) {
        index = block!.last;
        continue;
      }
      const end = line.start + line.text.length;
      const from = Math.max(range.start, line.start) - line.start;
      const to = Math.min(range.end, end) - line.start;
      const lineBreak = range.end > end && index < elements.length - 1;
      if (from >= to && !lineBreak) continue;
      const box = element.getBoundingClientRect();
      const runsIn = range.start < line.start;
      const selection = { from, to, runsIn, runsOn: range.end > end };
      const table = line.table && tableRowHighlight(element, line.table.cells, selection);
      if (table && table.kind === 'cells') {
        if (table.box) bands.push(bandOf(table.box, base));
        continue;
      }
      let sizes = rowSizes.get(element.className);
      if (sizes === undefined) {
        sizes = lineRowSizesOf(element, box);
        rowSizes.set(element.className, sizes);
      }
      const lineRowsOf = lineRows(element, box, sizes);
      const rowAt = (y: number) => lineRowAt(lineRowsOf, y);
      // Each selected row's horizontal extent, by row.
      const rows = new Map<number, [left: number, right: number]>();
      const drawnRows = new Map<number, LineRow>();
      // From the text after a format's edge to the text before one: no edge of a run that is
      // not selected.
      const start = pointInLine(element, from);
      span.setStart(...start);
      span.setEnd(...(from < to ? pointInLine(element, to, true) : start));
      const rects: DOMRect[] = from < to ? [...span.getClientRects()] : [];
      const pictures: DOMRect[] = [];
      // A selected atom is highlighted over its element, which draws it, not its character's
      // glyph, row by row (a wikilink's label wraps), a picture as a band of its own; a list
      // marker's on to the item's text start, as its unit holds the space after the marker too.
      const atoms = line.atoms.filter((atom) => atom.start < to && atom.end > from);
      if (atoms.length > 0) {
        const atomElements = atomElementsOf(element);
        for (const atom of atoms) {
          const atomElement = atomElements[line.atoms.indexOf(atom)];
          if (!atomElement) continue;
          if (atom.image) pictures.push(...atomElement.getClientRects());
          else if (atom.kind !== 'ListMarker') rects.push(...atomElement.getClientRects());
          else {
            const drawn = atomElement.getBoundingClientRect();
            const text = box.left + parseFloat(getComputedStyle(element).paddingLeft);
            rects.push(new DOMRect(drawn.left, drawn.top, text - drawn.left, drawn.height));
          }
        }
      }
      const pictureRows = new Set<number>();
      const lastRow = pictures.length > 0 ? rowAt(lineRowsOf.bottom).index : 0;
      for (const picture of pictures) {
        // Kept to its line's box: a table row scrolled sideways hides a cell's picture.
        const left = Math.max(picture.left, box.left);
        const right = Math.min(picture.right, box.right);
        if (right <= left) continue;
        const drawn = rowAt(picture.top + picture.height / 2);
        drawnRows.set(drawn.index, drawn);
        pictureRows.add(drawn.index);
        const reachTop = drawn.index === 0 ? box.top : drawn.top;
        const reachBottom = drawn.index === lastRow ? box.bottom : drawn.bottom;
        bands.push({
          left: left - base.left,
          top: picture.top - base.top,
          width: right - left,
          height: picture.height,
          rounded: ROUND_PICTURE,
          reach: {
            top: Math.min(reachTop, picture.top) - base.top,
            bottom: Math.max(reachBottom, picture.bottom) - base.top,
          },
        });
      }
      for (const rect of rects) {
        if (rect.width === 0 || pictures.some((picture) => isInside(rect, picture))) continue;
        const drawn = rowAt(rect.top + rect.height / 2);
        const row = drawn.index;
        drawnRows.set(row, drawn);
        const known = rows.get(row);
        rows.set(
          row,
          known
            ? [Math.min(known[0], rect.left), Math.max(known[1], rect.right)]
            : [rect.left, rect.right],
        );
      }
      // A line the selection runs into from above is highlighted from its left edge, its
      // indent (a list's marker, a quote's bars) included, so the band reads as one block;
      // a code line's edges are its code column's.
      const [lineLeft, lineRight] = line.code
        ? codeColumnOf(element, box)
        : (table?.edges ?? [box.left, box.right]);
      // A selected divider is highlighted across its row, as its rule is drawn.
      if (line.divider && from < to) {
        rows.set(0, [box.left, box.right]);
        drawnRows.set(0, rowAt(box.top));
      }
      if (lineBreak && rows.size === 0 && pictureRows.size === 0) {
        // Nothing of the line's text is selected: its break starts at the selection's start.
        span.collapse(true);
        const at = line.text ? span.getClientRects()[0] : null;
        const drawn = rowAt(at ? at.top + at.height / 2 : box.top);
        drawnRows.set(drawn.index, drawn);
        rows.set(drawn.index, [at?.left ?? lineLeft, at?.left ?? lineLeft]);
      }
      // A line or row of pictures alone: nothing beside them, the spaces between them included.
      const picturesAlone = pictureRows.size > 0 && isPictureLine(line);
      const ordered = [...new Set([...rows.keys(), ...pictureRows])].sort((a, b) => a - b);
      ordered.forEach((row, position) => {
        const extent = rows.get(row);
        if (!extent || picturesAlone) return;
        const [left, right] = extent;
        const runsOn = position < ordered.length - 1 || lineBreak;
        const bandLeft = Math.max(position === 0 && !runsIn ? left : lineLeft, lineLeft);
        const drawn = drawnRows.get(row)!;
        const bandRight = Math.min(runsOn ? lineRight : right, lineRight);
        // Text a table row scrolled sideways hides.
        if (bandRight < bandLeft) return;
        bands.push({
          left: bandLeft - base.left,
          top: drawn.top - base.top,
          width: bandRight - bandLeft,
          height: textBandHeight(drawn, lineRowsOf, runsOn),
        });
      });
    }
  });
  return joinRoundedBands(bands);
}

export class Highlight {
  private readonly layer = document.createElement('div');

  constructor(wrap: HTMLElement) {
    this.layer.className = 'desktop-selection';
    this.layer.setAttribute('aria-hidden', 'true');
    wrap.prepend(this.layer);
  }

  draw(bands: readonly Band[]): void {
    const layer = this.layer;
    while (layer.children.length > bands.length) layer.lastElementChild!.remove();
    while (layer.children.length < bands.length) layer.append(document.createElement('div'));
    bands.forEach((band, index) => {
      // Whole pixels, outward: rows meet at fractional heights, and two bands that only touch
      // there leave a hairline of page between them.
      const left = Math.floor(band.left);
      const top = Math.floor(band.top);
      const element = layer.children[index] as HTMLElement;
      const corners = band.rounded;
      const className = corners?.shape ?? '';
      if (element.className !== className) element.className = className;
      const style = element.style;
      style.borderTopLeftRadius = corners?.topLeft ? '0' : '';
      style.borderTopRightRadius = corners?.topRight ? '0' : '';
      style.borderBottomRightRadius = corners?.bottomRight ? '0' : '';
      style.borderBottomLeftRadius = corners?.bottomLeft ? '0' : '';
      style.transform = `translate(${left}px, ${top}px)`;
      style.width = `${Math.ceil(band.left + band.width) - left}px`;
      style.height = `${Math.ceil(band.top + band.height) - top}px`;
    });
  }
}
