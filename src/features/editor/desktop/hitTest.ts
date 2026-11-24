/* Where a point in the note pane lands, for the mouse (pointer.ts) and the keys that move by
 * rows (keys.ts). Off the text: left of a row is its start, right of it its end, under two line
 * heights below the last line its row at the pointer's column, and further down the end of the
 * note. Up, Down and the row's ends (Cmd+Left and Cmd+Right, Home and End) go through the same
 * hit-test. At a soft wrap the end of the upper row and the start of the lower one are one
 * offset: a hit says which row it aimed at (`Hit.rowEnd`). */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { CaretArrival } from './formats';
import { firstBelow } from './highlight';
import { lineRowAt, lineRowSizesOf, lineRows, type LineRows } from './lineRowAt';
import { atomElementsOf } from './atomElements';
import { wikilinkSideAt } from './wikilinkUnit';
import { reveal, scrollerOf } from './paneScroll';
import { tableCellTextBox, tableCellTextBoxAt } from './tableRowElements';
import { tableRowEdge } from './tableScroll';
import type { EditorView } from './view';

/** A hit-test's answer: the UTF-16 display offset, and whether the caret there is at the end
 *  of the row above the one that offset's ordinary caret draws on (a soft wrap); `arrival`,
 *  how a caret put there came (the side a press is on, or a key's landing); `atom`, the
 *  atom a press there is on, which any click count takes whole (a divider's row, an image);
 *  `marker`, the list marker a press there is on, which a double click takes as its word. */
export interface Hit {
  offset: number;
  rowEnd: boolean;
  arrival?: CaretArrival;
  atom?: DisplayRange;
  marker?: DisplayRange;
}

/** The DOM point at viewport `x`, `y`: WebKit and WebView2 name the call differently. */
function caretPoint(x: number, y: number): [Node, number] | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return [position.offsetNode, position.offset];
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range) return null;
  const point: [Node, number] = [range.startContainer, range.startOffset];
  // Parked outside the editor until it is collected (lineElements.ts `withMeasuringRange`).
  range.setStart(document, 0);
  range.collapse(true);
  return point;
}

/** A line element's row height, viewport px. */
function rowHeightOf(element: HTMLElement, box: DOMRect): number {
  return parseFloat(getComputedStyle(element).lineHeight) || box.height;
}

/** A line element's rows: its first row's top is below its top padding (a picture's gap), its
 *  last row's bottom above its bottom padding (a code block's skirt, the front matter's gap). */
function rowsOf(element: HTMLElement, box: DOMRect): LineRows {
  return lineRows(element, box, lineRowSizesOf(element, box));
}

export class EditorHitTest {
  constructor(private readonly view: EditorView) {}

  /** What a press at viewport `x`, `y` on line `index` (drawn in `element`) has to do with its
   *  atoms: the atom it takes whole (a divider anywhere on its row, an image inside its box, a
   *  wikilink on one of its rows) and its stop nearer the press, never inside it;
   *  on a list marker's box, the marker and the side of it nearer the press, as a character's;
   *  left of a marker on its row, the stop before it. A marker is out of the text's flow, so
   *  the browser's hit-test there gives the item's text start. */
  private atomHit(
    index: number,
    element: HTMLElement,
    x: number,
    y: number,
  ): { atom?: DisplayRange; edge?: number; marker?: DisplayRange; offset?: number } {
    const line = this.view.displayLines()[index];
    if (line.atoms.length === 0) return {};
    if (line.divider) return { atom: { start: line.start, end: line.start + line.text.length } };
    const atomElements = atomElementsOf(element);
    let row: { top: number; bottom: number } | null = null;
    for (const [position, atom] of line.atoms.entries()) {
      const range = { start: line.start + atom.start, end: line.start + atom.end };
      if (atom.kind === 'Wikilink') {
        row ??= lineRowAt(rowsOf(element, element.getBoundingClientRect()), y);
        const side = wikilinkSideAt(atomElements[position], x, row);
        if (side) return { atom: range, edge: side === 'Backward' ? range.start : range.end };
        continue;
      }
      const box = atomElements[position]?.getBoundingClientRect();
      if (!box || y < box.top || y >= box.bottom) continue;
      const marker = atom.kind === 'ListMarker';
      if (marker && x < box.left) return { offset: range.start };
      if (x < box.left || x >= box.right) continue;
      const nearer = x < (box.left + box.right) / 2 ? range.start : range.end;
      if (!marker) return { atom: range, edge: nearer };
      return { marker: range, offset: nearer };
    }
    return {};
  }

  /** `offset` (UTF-16), the browser's answer for a press at viewport `x`, `y` on line `index`
   *  (drawn in `element`), kept on the press's side of each picture whose rows the press is
   *  on: left of a picture it is no later than the stop before it, right of one no earlier
   *  than the stop after it. WebKit answers a press beside a picture with a point across it. */
  private besidePictures(
    index: number,
    element: HTMLElement,
    press: { x: number; y: number },
    offset: number,
  ): number {
    const line = this.view.displayLines()[index];
    if (!line.atoms.some((atom) => atom.image)) return offset;
    const atomElements = atomElementsOf(element);
    for (const [position, atom] of line.atoms.entries()) {
      const box = atom.image && atomElements[position]?.getBoundingClientRect();
      if (!box || press.y < box.top || press.y >= box.bottom) continue;
      if (press.x < box.left) offset = Math.min(offset, line.start + atom.start);
      else if (press.x >= box.right) offset = Math.max(offset, line.start + atom.end);
    }
    return offset;
  }

  /** The row of a caret at UTF-16 `from` (at the end of the row above with `rowEnd`): its
   *  top and bottom, a line unit's height and the caret's x, viewport px. */
  private caretRow(
    from: number,
    rowEnd: boolean,
  ): { top: number; bottom: number; height: number; x: number } {
    const view = this.view;
    const element = view.lineElements()[view.lineAt(from)];
    const box = element.getBoundingClientRect();
    const rows = rowsOf(element, box);
    const caret = view.caretSide.clientRect(from, rowEnd);
    const center = caret ? caret.top + caret.height / 2 : box.top + rows.rowHeight / 2;
    const { top, bottom } = lineRowAt(rows, center);
    return { top, bottom, height: rows.rowHeight, x: caret?.left ?? box.left };
  }

  /** Where Up or Down from UTF-16 `from` (a row end with `rowEnd`) goes: the hit-test a click
   *  at `goalX` (else the caret's own x) on the row above or below would make, that row
   *  scrolled into the pane first; from the first row Up goes to the note's start, from the
   *  last Down to its end. Off its line, the row aimed at is the middle of the next line's
   *  nearest row (in a table row, the nearest of the cell's under `x`), over any space between
   *  them (a code block's header and gap), however tall this line's rows are. Returns the hit,
   *  the x to keep for the next vertical move, and whether it went past the note's first or
   *  last row. */
  verticalStop(
    from: number,
    rowEnd: boolean,
    down: boolean,
    goalX: number | null,
  ): Hit & { x: number; pastNote: boolean } {
    const view = this.view;
    const elements = view.lineElements();
    const lines = view.displayLines();
    const row = this.caretRow(from, rowEnd);
    const x = goalX ?? row.x;
    // The middle of a row next to this one: a row's edge pixel can hit the line beside it.
    let y = down ? row.bottom + row.height / 2 : row.top - row.height / 2;
    const index = view.lineAt(from);
    const box =
      tableCellTextBox(elements[index], from - lines[index].start) ??
      elements[index].getBoundingClientRect();
    if (down ? y >= box.bottom : y < box.top) {
      // The next line drawn: a table's delimiter row has no height.
      let nextIndex = index + (down ? 1 : -1);
      while (elements[nextIndex]?.getBoundingClientRect().height === 0) nextIndex += down ? 1 : -1;
      const next = elements[nextIndex];
      if (!next && !down) return { offset: 0, rowEnd: false, x, pastNote: true };
      if (!next) {
        const end = lines[lines.length - 1];
        return { offset: end.start + end.text.length, rowEnd: false, x, pastNote: true };
      }
      // Half the next line's row past this row's edge, never half this row's: rows differ in
      // height (a heading's, a picture's), and a taller one would reach past the next line's
      // first row.
      const near = tableCellTextBoxAt(next, x) ?? next.getBoundingClientRect();
      const half = rowHeightOf(next, near) / 2;
      y = down
        ? Math.max(row.bottom + half, near.top + half)
        : Math.min(row.top - half, near.bottom - half);
    }
    const scroller = scrollerOf(view.dom);
    return { ...this.offsetAt(x, reveal(y, row.height, scroller), scroller), x, pastNote: false };
  }

  /** Where the caret's row starts or ends (Cmd+Left and Cmd+Right, Home and End) from UTF-16
   *  `from` (a row end with `rowEnd`): the hit-test a click left or right of that row would
   *  make, the row scrolled into the pane first. */
  rowEdge(from: number, rowEnd: boolean, toEnd: boolean): Hit {
    const edge = tableRowEdge(this.view.displayLines()[this.view.lineAt(from)], toEnd);
    if (edge !== null) return { offset: edge, rowEnd: false, arrival: { kind: 'landed' } };
    const row = this.caretRow(from, rowEnd);
    const scroller = scrollerOf(this.view.dom);
    const y = reveal(row.bottom - row.height / 2, row.height, scroller);
    return this.offsetAt(toEnd ? Infinity : -Infinity, y, scroller);
  }

  /** Where a press at viewport `x`, `y` lands (`hitAt`): a `pointed` one (the mouse's) on the
   *  side of its offset the pointer is over, a key's (a row edge, Up and Down) landed there. */
  offsetAt(x: number, y: number, scroller: HTMLElement, pointed = false): Hit {
    const hit = this.hitAt(x, y, scroller, pointed);
    const arrival: CaretArrival = pointed
      ? { kind: 'pressed', side: this.view.caretSide.pressedSide(hit.offset, x) }
      : { kind: 'landed' };
    return { ...hit, arrival };
  }

  /** Where a press at viewport `x`, `y` lands. A hit whose offset's ordinary caret would
   *  draw on a row below the one aimed at (right of a wrapped row) is that row's end. Only a
   *  `pointed` one on or left of a list marker lands beside it (`atomHit`): the keys keep to
   *  the item's text. */
  private hitAt(x: number, y: number, scroller: HTMLElement, pointed: boolean): Hit {
    const view = this.view;
    const elements = view.lineElements();
    const lines = view.displayLines();
    // Beyond the pane (a drag), the text at its edge.
    const pane = scroller.getBoundingClientRect();
    y = Math.min(Math.max(y, pane.top + 1), pane.bottom - 1);
    const last = elements[elements.length - 1].getBoundingClientRect();
    if (y >= last.bottom) {
      const row = parseFloat(getComputedStyle(view.dom).lineHeight);
      const end = lines[lines.length - 1];
      if (y - last.bottom >= 2 * row) return { offset: end.start + end.text.length, rowEnd: false };
      y = last.bottom - row / 2;
    }
    const index = Math.min(firstBelow(elements, y), elements.length - 1);
    const element = elements[index];
    const box = element.getBoundingClientRect();
    // The browser is asked at the middle of the row the press is on, never at the press: WebKit
    // answers a row's bottom pixel (two on a code row, its smaller font lower in the row) with
    // the row's end. A press in a line's padding (a code block's skirt, a gap beside a picture
    // or the front matter) is on its nearest row, an atom's included: in the gap over a picture,
    // on the picture.
    const rows = rowsOf(element, box);
    const row = lineRowAt(rows, y);
    const onRow = Math.min(Math.max(y, row.top), row.bottom - 1);
    const point = caretPoint(Math.min(Math.max(x, box.left + 1), box.right - 1), row.middle);
    const line = lines[index];
    if (!point || !view.dom.contains(point[0])) {
      const offset = x < box.left + box.width / 2 ? line.start : line.start + line.text.length;
      return { offset, rowEnd: false, atom: this.atomHit(index, element, x, onRow).atom };
    }
    const answered = Math.min(
      Math.max(view.offsetOf(point[0], point[1]), line.start),
      line.start + line.text.length,
    );
    const offset = this.besidePictures(index, element, { x, y: onRow }, answered);
    const caret = view.caretSide.clientRect(offset);
    const rowEnd = !!caret && lineRowAt(rows, caret.top + caret.height / 2).index > row.index;
    const found = this.atomHit(index, element, x, onRow);
    if (pointed && found.offset !== undefined && !found.atom) {
      return { offset: found.offset, rowEnd: false, marker: found.marker };
    }
    // On a picture or a wikilink, the stop on the side of it the press is on, never inside
    // its spelling.
    if (found.edge !== undefined) return { offset: found.edge, rowEnd: false, atom: found.atom };
    return { offset, rowEnd, atom: found.atom };
  }
}
