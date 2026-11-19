/* The page's tables beyond their lines (tableRowElements.ts): a wide table's sideways scroll
 * (tableLayouts.ts), the caret revealed sideways, and the row and column grips
 * (tableGrips.ts, TableGrips.svelte) of the cell the pointer is over, whose menus run the
 * engine's row and column commands on that cell. All of it is drawn on the caret's frame, first
 * (overlays.ts `paint`), so the caret, the highlight, find's bands and the toolbar measure the
 * rows as they are drawn in that frame; a pointer move only names the cell (tableHover.ts). */
import type { TableCommand, TableControls } from '@futo-notes/editor/wasm-payloads';
import { caretViewportRect, paneOf } from './caret';
import { firstBelow } from './highlight';
import { drawnLineOf } from './lineElements';
import { takeDrawnTableRows } from './tableDrawnRows';
import { TableLayouts, isTableRowLine, tableHeaderIndex } from './tableLayouts';
import { tableGripsAt, type TableGripsState } from './tableGrips';
import { TableHover } from './tableHover';
import { revealShift, sidewaysWheel } from './tableScroll';
import type { LineModel } from './lineModel';
import type { EditorView } from './view';

export class EditorTables {
  private readonly layouts: TableLayouts;
  /** The model the page last drew tables for, whether it held any, and the selection (its
   *  revision and focus) last revealed sideways. */
  private model: LineModel | null = null;
  private hasTables = false;
  private revealed = '';
  /** The pane's scroll and size and the line count the layouts were last written for, and
   *  whether a table's layout changed since. */
  private applied = '';
  private stale = false;
  private writtenRow: HTMLElement | null = null;
  /** The grips' state last handed out, as JSON: a frame that changes nothing hands none. */
  private shownGrips = 'null';
  private readonly hover: TableHover;

  constructor(
    private readonly view: EditorView,
    private readonly wrap: HTMLElement,
    private readonly showGrips: (state: TableGripsState | null) => void,
  ) {
    this.layouts = new TableLayouts(
      () => view.lineElements(),
      () => view.displayLines(),
    );
    this.hover = new TableHover(view, wrap, (row) => this.indexOf(row));
  }

  /** Listen on the editor `dom`: a sideways wheel over a row scrolls its table; a scroll of the
   *  pane brings other rows near the screen; the pointer over a cell (tableHover.ts). Returns
   *  the undo. */
  listen(dom: HTMLElement): () => void {
    const unhover = this.hover.listen();
    const wheel = (event: Event) => this.wheel(event as WheelEvent);
    const scrolled = (event: Event) => {
      if (!this.hasTables || event.target !== paneOf(dom)) return;
      this.hover.leave();
      this.view.redraw();
    };
    dom.addEventListener('wheel', wheel, { passive: true });
    document.addEventListener('scroll', scrolled, { capture: true, passive: true });
    return () => {
      unhover();
      dom.removeEventListener('wheel', wheel);
      document.removeEventListener('scroll', scrolled, { capture: true });
    };
  }

  /** On the caret's frame, before anything measures: give the rows drawn since the last their
   *  table's scroll, write it on the rows near the screen when the pane moved or a table
   *  scrolled, reveal a moved caret sideways, then place the grips. */
  paint(): void {
    const model = this.view.lineModel();
    if (model !== this.model) {
      this.model = model;
      this.hasTables = false;
      this.revealed = '';
      this.applied = '';
      this.hover.drop();
    }
    const drawn = takeDrawnTableRows(this.view.dom);
    if (drawn.length > 0) this.hasTables = true;
    if (!model || !this.hasTables) return this.handGrips(null);
    this.layouts.applyTo(drawn, (row) => this.indexOf(row));
    const pane = paneOf(this.view.dom);
    const applied = `${pane.scrollTop}:${pane.clientHeight}:${this.view.dom.clientWidth}:${model.lines.length}`;
    if (this.stale || applied !== this.applied) {
      this.applied = applied;
      this.stale = false;
      this.applyNearScreen();
    }
    this.markWrittenRow();
    this.revealCaret();
    this.handGrips(this.grips());
  }

  /** The delimiter row the caret is writing (the engine's `writes_delimiter_row`) is drawn for
   *  as long as it is being written: `data-writing` on its line (desktopTables.css). */
  private markWrittenRow(): void {
    const selection = this.view.selection;
    const range = selection.writesDelimiterRow() ? selection.range() : null;
    const row = range ? this.view.lineElements()[this.view.lineAt(range.start)] : null;
    if (row === this.writtenRow) return;
    this.writtenRow?.removeAttribute('data-writing');
    row?.setAttribute('data-writing', '');
    this.writtenRow = row ?? null;
  }

  /** Bring viewport `left` to `right` on line `index` into its table's row, when that is a
   *  table's (find's revealed match); true when the table scrolled. */
  reveal(index: number, left: number, right: number): boolean {
    if (!isTableRowLine(this.view.displayLines()[index])) return false;
    const row = this.view.lineElements()[index].getBoundingClientRect();
    const shift = revealShift(row, left, right);
    if (!shift || !this.layouts.scrollBy(index, shift)) return false;
    this.applyNearScreen();
    return true;
  }

  /** What the engine allows on the hovered cell (a menu's items); null with none. */
  controls(): TableControls | null {
    const range = this.hover.range();
    const engine = this.view.currentEngine();
    if (!range || !engine) return null;
    return engine.inspectTable(range)?.controls ?? null;
  }

  /** A grip's menu item: the engine's row or column command on the hovered cell, one Undo step;
   *  the editor takes focus, the caret where the engine puts it. */
  run(command: TableCommand): void {
    const range = this.hover.range();
    if (!range) return;
    this.view.run((engine) => engine.tableCommand(range, command));
    this.view.focus();
  }

  /** A grip's menu opened or closed: an open one pins the hovered cell. */
  pinHoveredCell(pinned: boolean): void {
    this.hover.pin(pinned);
  }

  private wheel(event: WheelEvent): void {
    const row = (event.target as Element | null)?.closest?.('.table-row');
    if (!(row instanceof HTMLElement)) return;
    const index = this.indexOf(row);
    if (index === null) return;
    const width = row.clientWidth;
    const shift = sidewaysWheel(event, width);
    if (shift === null || !this.layouts.scrollBy(index, shift)) return;
    this.stale = true;
    this.hover.leave();
    this.view.redraw();
  }

  /** The index of the line `row` is drawn from. */
  private indexOf(row: HTMLElement): number | null {
    const line = drawnLineOf(row);
    if (!line || !this.view.dom.contains(row)) return null;
    const index = this.view.lineAt(line.start);
    return this.view.lineElements()[index] === row ? index : null;
  }

  /** Write the tables' layouts on the lines from a screen above the window to a screen below. */
  private applyNearScreen(): void {
    const elements = this.view.lineElements();
    if (elements.length === 0) return;
    const screen = window.innerHeight;
    const first = Math.min(firstBelow(elements, -screen), elements.length - 1);
    const last = Math.min(firstBelow(elements, 2 * screen), elements.length - 1);
    this.layouts.apply(first, last);
  }

  /** A selection that moved or an edit since the last frame: its focus brought into its row
   *  when a table scrolled sideways hides it. A wheel's scroll moves no selection, so it stays. */
  private revealCaret(): void {
    const view = this.view;
    const ends = view.selection.ends();
    const range = view.selection.range();
    const focus = ends?.focus ?? range?.end;
    if (focus === undefined || view.isComposing()) return;
    const key = `${view.revision()}:${focus}`;
    if (key === this.revealed) return;
    this.revealed = key;
    const index = view.lineAt(focus);
    if (!isTableRowLine(view.displayLines()[index])) return;
    const rect = caretViewportRect(...view.pointAt(focus));
    if (rect) this.reveal(index, rect.left, rect.left);
  }

  /** The grips for the hovered cell. An edit, a composition or a note that cannot be edited
   *  takes them away until the pointer next moves over a cell; a selection (not a caret)
   *  reaching into its table hides them, as the selection toolbar may be where the column's
   *  grip goes. */
  private grips(): TableGripsState | null {
    const view = this.view;
    const cell = this.hover.cell();
    if (!cell) return null;
    const editable = view.dom.contentEditable === 'true';
    if (cell.revision !== view.revision() || view.isComposing() || !editable) {
      this.hover.drop();
      return null;
    }
    if (this.selectsInTable(cell.index)) return null;
    return tableGripsAt({
      elements: view.lineElements(),
      lines: view.displayLines(),
      index: cell.index,
      column: cell.column,
      origin: this.wrap.getBoundingClientRect(),
    });
  }

  /** Whether the editor holds a selection, not a caret, reaching into the table of line
   *  `index`: the selection toolbar shows over it. */
  private selectsInTable(index: number): boolean {
    const view = this.view;
    const range = view.selection.range();
    if (!range || range.start === range.end || document.activeElement !== view.dom) return false;
    const lines = view.displayLines();
    let last = index;
    while (lines[last + 1]?.table) last++;
    return (
      view.lineAt(range.start) <= last && view.lineAt(range.end) >= tableHeaderIndex(lines, index)
    );
  }

  private handGrips(state: TableGripsState | null): void {
    const json = JSON.stringify(state);
    if (json === this.shownGrips) return;
    this.shownGrips = json;
    this.showGrips(state);
  }
}
