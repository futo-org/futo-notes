/* A table wider than the text column (its columns at their minimum pass it: desktopTables.css)
 * scrolls sideways inside it: its rows clip what is past their box and shift their cells by the
 * table's scroll (tableLayouts.ts). The
 * text moves but the overlays measure the live text each frame (caret.ts, highlight.ts,
 * findBands.ts), so they follow it; what the row clips they clip too. */
import type { CaretBox } from './caret';
import type { Line } from './lineModel';
import { isTableRowElement } from './tableRowElements';

/** How far inside a row's sides the caret is kept when it is revealed: a line unit. */
const REVEAL_MARGIN_PX = 24;

/** A wheel's sideways distance in CSS px: its own, or a Shift+wheel's vertical one; null for a
 *  wheel that mostly scrolls the pane up or down. Lines count a line unit, pages `pageWidth`. */
export function sidewaysWheel(event: WheelEvent, pageWidth: number): number | null {
  const sideways = event.deltaX || (event.shiftKey ? event.deltaY : 0);
  if (!sideways || (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY))) {
    return null;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return sideways * REVEAL_MARGIN_PX;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return sideways * pageWidth;
  return sideways;
}

/** How far to scroll a table so viewport `left` to `right` shows inside `row` (viewport px),
 *  a line unit in from its sides where there is room; 0 when it already shows. */
export function revealShift(row: DOMRect, left: number, right: number): number {
  const margin = Math.min(REVEAL_MARGIN_PX, row.width / 4);
  if (left < row.left + margin) return left - (row.left + margin);
  if (right > row.right - margin) return Math.min(right - (row.right - margin), left - row.left);
  return 0;
}

/** The width of a table row's columns from its grid's resolved tracks (`grid-template-columns`
 *  as computed: each column's width in px), CSS px. */
export function tableColumnsWidth(tracks: string): number {
  return tracks.split(/\s+/).reduce((sum, track) => sum + (parseFloat(track) || 0), 0);
}

/** How far table row `row`'s table can scroll sideways, CSS px: its columns past the row's
 *  width, none when they fit. Read from the grid, so it never depends on a cell's text. */
export function tableScrollRoom(row: HTMLElement): number {
  const columns = tableColumnsWidth(getComputedStyle(row).gridTemplateColumns);
  return Math.max(0, Math.ceil(columns - row.clientWidth));
}

/** `rect` (viewport px) as much of it as table row `element` shows; null when it shows none of
 *  it, `rect` itself on any other line. */
export function clipToTableRow(element: HTMLElement, rect: DOMRect): DOMRect | null {
  if (!isTableRowElement(element)) return rect;
  const row = element.getBoundingClientRect();
  const left = Math.max(rect.left, row.left);
  const right = Math.min(rect.right, row.right);
  if (right < left) return null;
  return new DOMRect(left, rect.top, right - left, rect.height);
}

/** A caret at `box` (relative to `origin`) on line `element`; null where a table row scrolled
 *  sideways clips it. */
export function visibleCaret(
  element: HTMLElement,
  box: CaretBox,
  origin: HTMLElement,
): CaretBox | null {
  if (!isTableRowElement(element)) return box;
  const left = origin.getBoundingClientRect().left + box.left;
  const row = element.getBoundingClientRect();
  return left < row.left - 0.5 || left > row.right + 0.5 ? null : box;
}

/** Where Home and End (Cmd+Left and Cmd+Right) go on table row `line`: its first cell's start
 *  or its last cell's end (UTF-16 display offset), wherever the table is scrolled and however
 *  its cells wrap; null off a header or body row. */
export function tableRowEdge(line: Line, toEnd: boolean): number | null {
  const table = line.table;
  if (!table || table.role === 'delimiter' || table.cells.length === 0) return null;
  const cell = toEnd ? table.cells[table.cells.length - 1] : table.cells[0];
  return line.start + (toEnd ? cell.end : cell.start);
}
