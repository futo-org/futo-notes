/* A table line's element (tableLines.ts). A header or body row is a grid of its cells
 * (desktopTables.css): one element per cell holding the cell's text, padding spaces included
 * (its leading padding in an element of its own), drawn as a line's text is (lineSegments.ts);
 * the pipes in elements the grid does not draw;
 * and an empty filler per cell a shorter row lacks. The delimiter row holds its text, which
 * the page never draws. Every character stays in the line, in order, so the page's offsets
 * (lineElements.ts `offsetOf`, `pointInLine`) and the engine's stay one. A row drawn takes
 * its table's sideways scroll on the next frame (tableDrawnRows.ts). */
import type { Line } from './lineModel';
import type { TableCellSpan, TableLine } from './tableLines';
import { createSegment, draws, segmentsOf, textOf, type Segment } from './lineSegments';
import { pointInLine, withMeasuringRange } from './lineElements';
import { drawAtoms } from './atomElements';
import { markTableRowDrawn } from './tableDrawnRows';

const ROW_CLASS = 'table-row';
const PIPE_CLASS = 'table-pipe';
const CELL_CLASS = 'table-cell';
const FILLER_CLASS = 'table-filler';
const PADDING_CLASS = 'table-padding';
const COLUMNS = '--table-columns';
/** A cell's leading padding characters (desktopTables.css hangs its wrapped rows by them). */
const PADDING_COUNT = '--table-padding';
/** A table's layout on its rows (tableLayouts.ts): the page's, not its lines', as Puppet's drift
 *  check reads it (lineDrift.ts). */
export const TABLE_SCROLL = '--table-scroll';

type RowPart =
  | { kind: typeof PIPE_CLASS; text: string }
  | { kind: typeof CELL_CLASS; className: string; segments: Segment[]; padding: number }
  | { kind: typeof FILLER_CLASS };

/** A table line's classes after `line`: `table-row` (and `header` on the first row) or
 *  `table-delimiter`. */
export function tableLineClass(table: TableLine): string {
  if (table.role === 'delimiter') return ' table-delimiter';
  return table.role === 'header' ? ` ${ROW_CLASS} header` : ` ${ROW_CLASS}`;
}

/** The part of `line` from `start` to `end`, as a line of its own: its text, runs, links and
 *  atoms. */
function cellLine(line: Line, start: number, end: number): Line {
  const within = <T extends { start: number; end: number }>(pieces: readonly T[]): T[] =>
    pieces
      .filter((piece) => piece.start < end && piece.end > start)
      .map((piece) => ({
        ...piece,
        start: Math.max(piece.start, start) - start,
        end: Math.min(piece.end, end) - start,
      }));
  return {
    ...line,
    text: line.text.slice(start, end),
    runs: within(line.runs),
    atoms: within(line.atoms),
    links: within(line.links),
    tags: within(line.tags),
    list: null,
  };
}

/** What a cell draws: its leading padding apart (desktopTables.css draws it a quarter em a
 *  space), then its content and trailing padding. */
function cellSegments(line: Line, cell: TableCellSpan): Segment[] {
  const segments = segmentsOf(cellLine(line, cell.content, cell.end));
  if (cell.content === cell.start) return segments;
  const padding = line.text.slice(cell.start, cell.content);
  return [{ kind: 'run', text: padding, className: PADDING_CLASS }, ...segments];
}

const ALIGNMENT_CLASSES = { None: '', Left: '', Center: ' center', Right: ' right' } as const;

/** What a row draws, in order: its pipes and cells, then a filler per column it lacks. */
function rowParts(line: Line, table: Extract<TableLine, { role: 'header' | 'row' }>): RowPart[] {
  const parts: RowPart[] = [];
  let at = 0;
  table.cells.forEach((cell, column) => {
    parts.push({ kind: PIPE_CLASS, text: line.text.slice(at, cell.start) });
    const alignment = ALIGNMENT_CLASSES[table.alignments[column] ?? 'None'];
    parts.push({
      kind: CELL_CLASS,
      className: CELL_CLASS + alignment,
      segments: cellSegments(line, cell),
      padding: cell.content - cell.start,
    });
    at = cell.end;
  });
  if (at < line.text.length) parts.push({ kind: PIPE_CLASS, text: line.text.slice(at) });
  for (let column = table.cells.length; column < table.columns; column++) {
    parts.push({ kind: FILLER_CLASS });
  }
  return parts;
}

function createPart(part: RowPart): HTMLElement {
  const element = document.createElement('span');
  element.className = part.kind;
  if (part.kind === FILLER_CLASS) {
    element.contentEditable = 'false';
    element.setAttribute('aria-hidden', 'true');
  }
  return element;
}

/** Draw `segments` into a cell's element, rewriting a text in place where it can (typing in a
 *  cell rewrites its one text node alone). */
function drawCell(cell: HTMLElement, segments: readonly Segment[]): void {
  segments.forEach((segment, index) => {
    const old = cell.childNodes[index];
    const text = old && textOf(old, segment);
    if (text) {
      if (text.data !== segment.text) text.data = segment.text;
      return;
    }
    if (old && draws(old, segment)) return;
    const node = createSegment(segment);
    if (old) old.replaceWith(node);
    else cell.append(node);
  });
  while (cell.childNodes.length > segments.length) cell.lastChild!.remove();
}

/** Set custom property `name` on `element` to `value`, or remove it for an empty one (and an
 *  emptied `style` with it, as a fresh draw has none), writing nothing when it already holds it. */
export function setStyleProperty(element: HTMLElement, name: string, value: string): void {
  if (element.style.getPropertyValue(name) === value) return;
  if (value) return element.style.setProperty(name, value);
  element.style.removeProperty(name);
  if (element.style.length === 0) element.removeAttribute('style');
}

function hasShape(element: HTMLElement, parts: readonly RowPart[]): boolean {
  const children = element.childNodes;
  return (
    children.length === parts.length &&
    parts.every((part, index) => {
      const child = children[index];
      return child instanceof HTMLElement && child.classList.contains(part.kind);
    })
  );
}

function drawRow(
  element: HTMLElement,
  line: Line,
  table: Extract<TableLine, { role: 'header' | 'row' }>,
): void {
  const parts = rowParts(line, table);
  if (!hasShape(element, parts)) element.replaceChildren(...parts.map(createPart));
  parts.forEach((part, index) => {
    const child = element.childNodes[index] as HTMLElement;
    if (part.kind === PIPE_CLASS) {
      if (child.textContent !== part.text) child.textContent = part.text;
    } else if (part.kind === CELL_CLASS) {
      if (child.className !== part.className) child.className = part.className;
      setStyleProperty(child, PADDING_COUNT, part.padding ? String(part.padding) : '');
      drawCell(child, part.segments);
    }
  });
  drawAtoms(element, line);
  markTableRowDrawn(element);
}

/** Draw `line` into `element` when it is a table's (its classes are drawLine's); false for a
 *  line that is no table's, whose element then holds no column count. */
export function drawTableLine(element: HTMLElement, line: Line): boolean {
  const table = line.table;
  const isRow = !!table && table.role !== 'delimiter';
  setStyleProperty(element, COLUMNS, isRow ? String(table.columns) : '');
  if (!isRow) setStyleProperty(element, TABLE_SCROLL, '');
  if (!table) return false;
  if (table.role !== 'delimiter') {
    drawRow(element, line, table);
    return true;
  }
  const only = element.firstChild;
  if (!(only instanceof Text) || only.nextSibling) element.replaceChildren(line.text);
  else if (only.data !== line.text) only.data = line.text;
  return true;
}

export function isTableRowElement(element: HTMLElement): boolean {
  return element.classList.contains(ROW_CLASS);
}

function isCellElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains(CELL_CLASS);
}

/** The DOM point at UTF-16 `at` in a table row's element: inside a cell's text, as
 *  `pointInLine` finds it there. A point in a pipe, which draws nothing, is the end of the cell
 *  before it, or the first cell's start for the row's leading pipe. */
export function pointInTableRow(element: HTMLElement, at: number, before: boolean): [Node, number] {
  let units = 0;
  let previous: HTMLElement | null = null;
  for (const part of element.childNodes) {
    const length = part.textContent?.length ?? 0;
    if (isCellElement(part)) {
      if (at <= units + length) return pointInLine(part, at - units, before);
      previous = part;
    } else if (at < units + length) {
      if (previous) return pointInLine(previous, previous.textContent!.length, true);
      const first = [...element.childNodes].find(isCellElement);
      return first ? pointInLine(first, 0) : [element, 0];
    }
    units += length;
  }
  return previous ? pointInLine(previous, previous.textContent!.length, true) : [element, 0];
}

/** The cell element of a table row's element whose text holds UTF-16 `at` (its ends included);
 *  null at a pipe, and on a line that is no table row. */
function cellAt(element: HTMLElement, at: number): HTMLElement | null {
  let units = 0;
  for (const part of element.childNodes) {
    const length = part.textContent?.length ?? 0;
    if (isCellElement(part) && at >= units && at <= units + length) return part;
    units += length;
  }
  return null;
}

/** Where a caret at the DOM point in a table cell that draws no text stands (`||`, a row's
 *  last cell with nothing after its pipe): where the cell's text would start, inside its
 *  padding and by its alignment, on the cell's first line unit (viewport px; caret.ts stands
 *  it on that row). A point in an empty element measures no box of its own, so the browser
 *  would fall to the row's edge. Null for any other point. */
export function emptyCellStopRect(node: Node): DOMRect | null {
  if (!isCellElement(node) || node.textContent) return null;
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const left = box.left + parseFloat(style.paddingLeft);
  const right = box.right - parseFloat(style.paddingRight);
  const x =
    style.textAlign === 'center' ? (left + right) / 2 : style.textAlign === 'right' ? right : left;
  // The cell's first line unit: a cell stretched to a taller row keeps its text at the top.
  return new DOMRect(x, box.top, 0, parseFloat(style.lineHeight) || box.height);
}

/** The box of the text in the cell holding UTF-16 `at` of a table row (viewport px), so Up and
 *  Down leave a short cell for the next row although a taller cell beside it holds the row
 *  open; null outside a cell. */
export function tableCellTextBox(element: HTMLElement, at: number): DOMRect | null {
  const cell = isTableRowElement(element) ? cellAt(element, at) : null;
  return cell && cellTextBox(cell);
}

/** The box of the text in the cell of a table row under viewport `x` (viewport px), so Up and
 *  Down come into a short cell's own rows although a taller cell beside it holds the row
 *  open; null off a row's cells, and for a cell with no text. */
export function tableCellTextBoxAt(element: HTMLElement, x: number): DOMRect | null {
  if (!isTableRowElement(element)) return null;
  for (const part of element.childNodes) {
    if (!isCellElement(part)) continue;
    const box = part.getBoundingClientRect();
    if (x >= box.left && x < box.right) return cellTextBox(part);
  }
  return null;
}

function cellTextBox(cell: HTMLElement): DOMRect | null {
  const box = withMeasuringRange((range) => {
    range.selectNodeContents(cell);
    return range.getBoundingClientRect();
  });
  return box.height > 0 ? box : null;
}

/** A selection on one table row: from and to in the row's UTF-16 units, and whether it runs into
 *  the row from above or on past it. */
interface TableRowSelection {
  from: number;
  to: number;
  runsIn: boolean;
  runsOn: boolean;
}

/** How a selection shows in a table row (viewport px): inside one of its cells, as text kept to
 *  that cell's column; crossing cells, or running into or past the row, over the cells it
 *  touches whole (`box`, null when the row shows none of them). */
export type TableRowHighlight =
  { kind: 'column'; edges: [left: number, right: number] } | { kind: 'cells'; box: DOMRect | null };

/** How `selection` shows in a table row (`element`, drawn from `cells`). */
export function tableRowHighlight(
  element: HTMLElement,
  cells: readonly TableCellSpan[],
  selection: TableRowSelection,
): TableRowHighlight {
  const column =
    selection.runsIn || selection.runsOn
      ? null
      : tableColumnOf(element, selection.from, selection.to);
  if (column) return { kind: 'column', edges: column };
  return { kind: 'cells', box: tableCellsBox(element, cells, selection) };
}

/** The left and right of the cell (viewport px) holding a row's UTF-16 `from` to `to` whole,
 *  as much of it as the row shows (a table scrolled sideways clips it). Null when the range is
 *  not inside one cell. */
function tableColumnOf(element: HTMLElement, from: number, to: number): [number, number] | null {
  const cell = isTableRowElement(element) ? cellAt(element, from) : null;
  if (!cell || cellAt(element, to) !== cell) return null;
  const box = cell.getBoundingClientRect();
  const row = element.getBoundingClientRect();
  return [Math.max(box.left, row.left), Math.min(box.right, row.right)];
}

/** The box (viewport px, the row's height) of the cells of a table row (its `cells`, drawn by
 *  `element`) that a selection crossing cells touches, each whole: in reading order, from the
 *  cell holding the selection's UTF-16 `from` in the row, or the first when it `runsIn` from
 *  above, to the cell holding `to`, or the last with the fillers after it when it `runsOn` past
 *  the row. A cell's ends count as in it. As much of them as the row shows; null for none. */
function tableCellsBox(
  element: HTMLElement,
  cells: readonly TableCellSpan[],
  selection: TableRowSelection,
): DOMRect | null {
  const parts = [...element.children].filter(
    (part) => part.classList.contains(CELL_CLASS) || part.classList.contains(FILLER_CLASS),
  );
  let first = selection.runsIn ? 0 : cells.findIndex((cell) => cell.end >= selection.from);
  if (first < 0) first = cells.length;
  let last = selection.runsOn ? parts.length - 1 : -1;
  if (!selection.runsOn) cells.forEach((cell, at) => cell.start <= selection.to && (last = at));
  if (first > last || last >= parts.length) return null;
  const row = element.getBoundingClientRect();
  const left = Math.max(parts[first].getBoundingClientRect().left, row.left);
  const right = Math.min(parts[last].getBoundingClientRect().right, row.right);
  return right > left ? new DOMRect(left, row.top, right - left, row.height) : null;
}

/** The UTF-16 units of a table row's text before the DOM point `node`/`offset` in it, its
 *  pipes' included. */
export function unitsBeforeInTableRow(element: HTMLElement, node: Node, offset: number): number {
  return withMeasuringRange((range) => {
    range.setStart(element, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  });
}
