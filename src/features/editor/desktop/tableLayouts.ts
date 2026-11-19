/* Each table's sideways scroll (desktopTables.css `--table-scroll`), kept per table and keyed by
 * its header row's element. Only a table whose columns at their minimum pass the text column is
 * wider than its rows, and only that one scrolls: as far as its columns reach past the row
 * (tableScroll.ts `tableScrollRoom`), read when it scrolls, never from its cells' text. Rows are
 * flat line elements with no element of the table around them, so the scroll is written on each
 * row: a row drawn takes it on the next frame (`applyTo`), and the rows near the screen take it
 * when the table scrolls or the pane moves (`apply`). */
import type { Line } from './lineModel';
import { TABLE_SCROLL, isTableRowElement, setStyleProperty } from './tableRowElements';
import { tableScrollRoom } from './tableScroll';

/** Whether line `line` is a header or body row (not the delimiter row, not outside a table). */
export function isTableRowLine(line: Line | undefined): boolean {
  return !!line?.table && line.table.role !== 'delimiter';
}

/** The index of the header of the table line `index` is in: the first of its run of table
 *  lines (two tables always have a line that is no table's between them). */
export function tableHeaderIndex(lines: readonly Line[], index: number): number {
  let first = index;
  while (first > 0 && lines[first - 1].table) first--;
  return first;
}

export class TableLayouts {
  /** How far each table is scrolled sideways, CSS px, by its header row's element. */
  private readonly scrolls = new WeakMap<HTMLElement, number>();
  /** Whether a table of this view ever scrolled: until one does, no row needs a scroll. */
  private anyScrolled = false;

  constructor(
    private readonly elements: () => readonly HTMLElement[],
    private readonly lines: () => readonly Line[],
  ) {}

  /** How far the table of line `index` is scrolled sideways, CSS px. */
  scrollAt(index: number): number {
    return this.scrolls.get(this.elements()[tableHeaderIndex(this.lines(), index)]) ?? 0;
  }

  /** Scroll the table of line `index` by `shift` CSS px, kept between its start and as far as
   *  its columns reach past its row; true when it moved. */
  scrollBy(index: number, shift: number): boolean {
    const elements = this.elements();
    const header = elements[tableHeaderIndex(this.lines(), index)];
    const scroll = this.scrolls.get(header) ?? 0;
    const room = tableScrollRoom(elements[index]);
    const next = Math.round(Math.min(Math.max(scroll + shift, 0), room));
    if (next === scroll) return false;
    this.scrolls.set(header, next);
    if (next > 0) this.anyScrolled = true;
    return true;
  }

  /** Write each table's scroll on its rows among lines `first` to `last`, a scroll the table no
   *  longer has room for (a wider window) brought back first. */
  apply(first: number, last: number): void {
    if (!this.anyScrolled) return;
    const lines = this.lines();
    const elements = this.elements();
    let scroll: number | null = null;
    for (let index = first; index <= last && index < lines.length; index++) {
      if (!lines[index].table) {
        scroll = null;
        continue;
      }
      if (!isTableRowLine(lines[index])) continue;
      if (scroll === null) {
        if (this.scrollAt(index) > 0) this.scrollBy(index, 0);
        scroll = this.scrollAt(index);
      }
      setStyleProperty(elements[index], TABLE_SCROLL, scroll ? `${scroll}px` : '');
    }
  }

  /** Write their tables' scroll on `rows`, drawn since the last frame (`indexOf` finds a row's
   *  line): nothing until a table of the view has scrolled, so typing in a cell costs nothing. */
  applyTo(rows: readonly HTMLElement[], indexOf: (row: HTMLElement) => number | null): void {
    if (!this.anyScrolled) return;
    for (const row of rows) {
      const index = isTableRowElement(row) ? indexOf(row) : null;
      if (index === null) continue;
      const scroll = this.scrollAt(index);
      setStyleProperty(row, TABLE_SCROLL, scroll ? `${scroll}px` : '');
    }
  }
}
