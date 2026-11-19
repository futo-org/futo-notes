/* Which table cell the pointer is over, for its row and column grips (editorTables.ts). It
 * listens on the editor's wrapper, which holds the lines and the grips, so the pointer resting
 * on a grip or crossing to it keeps the cell. A move reads no layout: the cell is the move's
 * target. An open grip menu pins the cell. */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { EditorView } from './view';

/** The cell the pointer is over: its line's index and its column, in the revision it was
 *  found in. */
export interface HoveredCell {
  index: number;
  column: number;
  revision: number;
}

export class TableHover {
  private hovered: HoveredCell | null = null;
  /** An open grip menu holds the cell, so the pointer crossing the rows the menu drops over
   *  retargets nothing; whether the pointer left the wrapper meanwhile. */
  private pinned = false;
  private pointerLeft = false;

  constructor(
    private readonly view: EditorView,
    private readonly wrap: HTMLElement,
    private readonly indexOf: (row: HTMLElement) => number | null,
  ) {}

  /** Follow the pointer over the wrapper. Returns the undo. */
  listen(): () => void {
    const moved = (event: Event) => this.pointerMoved(event as MouseEvent);
    const left = () => {
      this.pointerLeft = true;
      this.leave();
    };
    this.wrap.addEventListener('mousemove', moved);
    this.wrap.addEventListener('mouseleave', left);
    return () => {
      this.wrap.removeEventListener('mousemove', moved);
      this.wrap.removeEventListener('mouseleave', left);
    };
  }

  /** The hovered cell; null with none. */
  cell(): HoveredCell | null {
    return this.hovered;
  }

  /** A caret in the hovered cell, where its content starts, as the engine's table calls take a
   *  cell; null with none hovered, since an edit, or in a note that cannot be edited. */
  range(): DisplayRange | null {
    const cell = this.hovered;
    const editable = this.view.dom.contentEditable === 'true';
    if (!cell || cell.revision !== this.view.revision() || !editable) return null;
    const line = this.view.displayLines()[cell.index];
    const table = line?.table;
    const span = table && table.role !== 'delimiter' ? table.cells[cell.column] : undefined;
    if (!span) return null;
    const at = line.start + span.content;
    return { start: at, end: at };
  }

  /** A grip's menu opened or closed: while one is open the cell stays, wherever the pointer
   *  goes; closed, a pointer that left meanwhile takes the grips away. */
  pin(pinned: boolean): void {
    this.pinned = pinned && this.hovered !== null;
    if (!pinned && this.pointerLeft) this.leave();
  }

  /** No cell until the pointer next moves over one, unless a menu pins it. */
  leave(): void {
    this.hover(null);
  }

  /** No cell, a pinned one included: an edit, a composition, another note. */
  drop(): void {
    this.hovered = null;
    this.pinned = false;
  }

  /** A move over the grips keeps their cell; with a button held (a press dragging) or off a
   *  cell of a note that can be edited, the cell goes. */
  private pointerMoved(event: MouseEvent): void {
    this.pointerLeft = false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.desktop-table-grips')) return;
    const cell = target?.closest('.table-cell');
    const row = cell?.parentElement;
    const index = row && event.buttons === 0 ? this.indexOf(row) : null;
    if (!cell || !row || index === null || this.view.dom.contentEditable !== 'true') {
      return this.leave();
    }
    const column = [...row.children]
      .filter((part) => part.classList.contains('table-cell'))
      .indexOf(cell);
    this.hover({ index, column, revision: this.view.revision() });
  }

  /** Grips for `cell`, none for null, drawn on the next frame; nothing while a menu pins one. */
  private hover(cell: HoveredCell | null): void {
    const shown = this.hovered;
    const same =
      shown?.index === cell?.index &&
      shown?.column === cell?.column &&
      shown?.revision === cell?.revision;
    if (this.pinned || same) return;
    this.hovered = cell;
    this.view.redraw();
  }
}
