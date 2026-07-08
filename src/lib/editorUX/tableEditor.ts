import { WidgetType, EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { StateField, RangeSet, StateEffect } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { parseMarkdownTable } from '$lib/tableWidget';
import {
  isMarkdownSelectionRevealSuppressed,
  liveMarkdownRefresh,
  selectionTouchesRange,
} from '$lib/liveMarkdownTransform';
import type { ParsedTable } from '$lib/tableWidget';
import {
  addColumn,
  addRow,
  cycleAlign,
  deleteColumn,
  deleteRow,
  moveColumn,
  moveRow,
  serialize,
  setAlign,
  setCellContent,
  type Align,
} from './tableOps';
import { setTableFocusEffect } from './selectionToolbar';
import { renderIcon } from './icons';

/**
 * Interactive table editor.
 *
 * Replaces the entire markdown table source with a DOM widget containing
 * contentEditable cells and hover controls for row/column operations. Edits
 * flow back to the markdown source by re-serializing the parsed table and
 * dispatching a single transaction.
 *
 * Behavioral notes:
 * - IME-safe: during composition, the cell DOM is not synced back to the doc.
 * - Undo/redo: each settled edit is one transaction, so CM6 undo steps snap
 *   between table versions cleanly.
 * - The widget reuses its DOM across updates (via `updateDOM`), so typing in
 *   a cell doesn't rebuild the element under the user.
 */

const SYNC_DEBOUNCE_MS = 180;
const DRAG_MIME_ROW = 'application/x-sf-table-row';
const DRAG_MIME_COL = 'application/x-sf-table-col';

/**
 * Build cell content from the current DOM. Reads `textContent` directly since
 * cells are plain-text only (GFM doesn't support block content in cells).
 */
function cellTextFromElement(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\r?\n/g, ' ');
}

class TableEditorWidget extends WidgetType {
  /** Source markdown range for this table in the doc */
  readonly from: number;
  readonly to: number;
  /** The markdown source used to build this widget. Used for `eq` comparisons. */
  readonly sourceText: string;
  /** Parsed at construction time. Mutated in place by user edits before re-serialize. */
  private table: ParsedTable;
  /** Kept in sync with the DOM so we can diff on updateDOM. */
  private dom: HTMLElement | null = null;
  private cellEls: HTMLElement[][] = [];
  /** -1-indexed: [headers][data rows] */
  private headerEls: HTMLElement[] = [];
  private pendingSyncTimer: number | null = null;
  private isComposing = false;
  private view: EditorView | null = null;

  constructor(sourceText: string, from: number, to: number) {
    super();
    this.sourceText = sourceText;
    this.from = from;
    this.to = to;
    const parsed = parseMarkdownTable(sourceText);
    this.table = parsed ?? { headers: [], rows: [], alignments: [] };
  }

  /** Called by CM6 once per initial mount. */
  toDOM(view: EditorView): HTMLElement {
    this.view = view;
    const root = document.createElement('div');
    root.className = 'sf-table';
    root.contentEditable = 'false';

    const scroll = document.createElement('div');
    scroll.className = 'sf-table__scroll';
    root.appendChild(scroll);

    const table = document.createElement('table');
    scroll.appendChild(table);
    this.renderInto(root, table);

    this.dom = root;
    this.attachHoverCoordination(root);
    return root;
  }

  private showControlsTimer: number | null = null;

  /**
   * JS-coordinated visibility for row/column controls. CSS-only `:hover` loses
   * the hover state the moment the pointer exits the table rect — but the
   * controls sit OUTSIDE that rect (in the gutter above/beside). With a short
   * delay and manual enter/leave tracking on both the table AND controls
   * themselves, the pointer can cross the gap and the controls stay live.
   */
  private attachHoverCoordination(root: HTMLElement): void {
    const scheduleHide = () => {
      if (this.showControlsTimer != null) window.clearTimeout(this.showControlsTimer);
      this.showControlsTimer = window.setTimeout(() => {
        this.showControlsTimer = null;
        root.classList.remove('sf-table--show-controls');
      }, 250);
    };
    const show = () => {
      if (this.showControlsTimer != null) window.clearTimeout(this.showControlsTimer);
      this.showControlsTimer = null;
      root.classList.add('sf-table--show-controls');
    };

    root.addEventListener('pointerenter', show);
    root.addEventListener('pointerleave', (e) => {
      // If pointer moved to a control (which is a child of root), pointerleave
      // on root doesn't fire (children don't trigger leave) — safe to rely on
      // child's own pointerenter to keep it visible.
      const next = e.relatedTarget as Node | null;
      if (next && root.contains(next)) return;
      scheduleHide();
    });
  }

  /**
   * When CM6 wants to replace this widget with a new one, try to update in place.
   * Returning true means "I handled the update, keep my DOM".
   *
   * CM6 calls updateDOM on the NEW widget instance — but the existing DOM was
   * built by the OLD widget and the new widget's internal refs (`cellEls`,
   * `headerEls`) start out empty. Before rendering, we harvest those refs from
   * the existing DOM so `renderInto` can take the non-structural branch and
   * leave the focused contentEditable cell alone.
   */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.view = view;
    this.dom = dom;
    const table = dom.querySelector('table');
    if (!table) return false;
    this.adoptExistingDom(dom);
    this.renderInto(dom, table as HTMLTableElement);
    return true;
  }

  /** Read existing cell/header elements from the DOM so non-structural updates reuse them. */
  private adoptExistingDom(root: HTMLElement): void {
    const ths = root.querySelectorAll<HTMLElement>('thead .sf-table__cell');
    this.headerEls = Array.from(ths);
    const trs = root.querySelectorAll<HTMLElement>('tbody tr');
    this.cellEls = Array.from(trs).map((tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>('.sf-table__cell')),
    );
  }

  /**
   * Build (or rebuild) the DOM to match `this.table`. Structural changes (row/col count)
   * trigger a full rebuild; otherwise we update only cells whose content differs, so the
   * currently-focused contentEditable cell isn't disturbed.
   */
  private renderInto(root: HTMLElement, table: HTMLTableElement): void {
    const t = this.table;
    const prevRowCount = this.cellEls.length;
    const prevColCount = this.headerEls.length;
    const rowCount = t.rows.length;
    const colCount = t.headers.length;
    const structural = prevRowCount !== rowCount || prevColCount !== colCount;

    if (structural) {
      table.replaceChildren();
      this.cellEls = [];
      this.headerEls = [];
      this.buildHead(table, t);
      this.buildBody(table, t);
      this.attachOverlays(root);
    } else {
      this.updateHeader(t);
      this.updateBody(t);
      this.updateColControlAlignments(t);
    }
  }

  private buildHead(table: HTMLTableElement, t: ParsedTable): void {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    t.headers.forEach((cell, col) => {
      const th = document.createElement('th');
      th.appendChild(this.buildCell(cell.content, cell.align, -1, col, /*header*/ true));
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  private buildBody(table: HTMLTableElement, t: ParsedTable): void {
    const tbody = document.createElement('tbody');
    t.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      tr.dataset.rowIndex = String(r);
      row.forEach((cell, col) => {
        const td = document.createElement('td');
        td.appendChild(this.buildCell(cell.content, cell.align, r, col, false));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  private buildCell(
    text: string,
    align: Align,
    row: number,
    col: number,
    header: boolean,
  ): HTMLElement {
    const div = document.createElement('div');
    div.className = 'sf-table__cell';
    div.contentEditable = 'true';
    div.setAttribute('role', header ? 'columnheader' : 'gridcell');
    div.dataset.row = String(row);
    div.dataset.col = String(col);
    div.dataset.align = align;
    div.textContent = text;

    div.addEventListener('focus', () => this.onCellFocus());
    div.addEventListener('blur', () => this.onCellBlur());
    div.addEventListener('input', () => this.onCellInput(row, col, div));
    div.addEventListener('keydown', (e) => this.onCellKeydown(e, row, col, div));
    div.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });
    div.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.onCellInput(row, col, div);
    });

    if (header) {
      this.headerEls[col] = div;
    } else {
      if (!this.cellEls[row]) this.cellEls[row] = [];
      this.cellEls[row][col] = div;
    }
    return div;
  }

  private updateHeader(t: ParsedTable): void {
    t.headers.forEach((cell, col) => {
      const el = this.headerEls[col];
      if (!el) return;
      if (document.activeElement !== el) {
        if (el.textContent !== cell.content) el.textContent = cell.content;
      }
      el.dataset.align = cell.align;
    });
  }

  private updateBody(t: ParsedTable): void {
    t.rows.forEach((row, r) => {
      row.forEach((cell, col) => {
        const el = this.cellEls[r]?.[col];
        if (!el) return;
        if (document.activeElement !== el) {
          if (el.textContent !== cell.content) el.textContent = cell.content;
        }
        el.dataset.align = cell.align;
      });
    });
  }

  /** Overlay controls — row controls down the left, column controls along the top. */
  private attachOverlays(root: HTMLElement): void {
    // Remove any existing
    root
      .querySelectorAll('.sf-table__row-controls, .sf-table__col-controls')
      .forEach((n) => n.remove());

    // Column controls
    this.table.headers.forEach((_, col) => {
      const controls = document.createElement('div');
      controls.className = 'sf-table__col-controls';
      controls.dataset.col = String(col);

      const drag = document.createElement('button');
      drag.type = 'button';
      drag.className = 'sf-table__drag';
      drag.setAttribute('aria-label', 'Drag column');
      drag.draggable = true;
      drag.innerHTML = renderIcon('GripVertical');
      drag.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(DRAG_MIME_COL, String(col));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      controls.appendChild(drag);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.setAttribute('aria-label', 'Add column to right');
      addBtn.innerHTML = renderIcon('Plus');
      addBtn.addEventListener('mousedown', (e) => e.preventDefault());
      addBtn.addEventListener('click', () => {
        this.mutateAndSync((t) => addColumn(t, col + 1));
      });
      controls.appendChild(addBtn);

      const alignBtn = document.createElement('button');
      alignBtn.type = 'button';
      alignBtn.dataset.role = 'align';
      alignBtn.setAttribute('aria-label', 'Cycle alignment');
      alignBtn.innerHTML = renderIcon(alignIconName(this.table.alignments[col] ?? 'left'));
      alignBtn.addEventListener('mousedown', (e) => e.preventDefault());
      alignBtn.addEventListener('click', () => {
        this.mutateAndSync((t) => {
          const next = cycleAlign(t.alignments[col] ?? 'left');
          return setAlign(t, col, next);
        });
      });
      controls.appendChild(alignBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', 'Delete column');
      delBtn.innerHTML = renderIcon('Trash');
      delBtn.addEventListener('mousedown', (e) => e.preventDefault());
      delBtn.addEventListener('click', () => {
        this.mutateAndSync((t) => deleteColumn(t, col));
      });
      controls.appendChild(delBtn);

      // Position over the corresponding header cell
      const th = root.querySelectorAll('thead th')[col] as HTMLElement | undefined;
      if (th) {
        const thLeft = th.offsetLeft;
        controls.style.left = `${thLeft}px`;
      }
      root.appendChild(controls);
    });

    // Row controls — one per body row
    this.table.rows.forEach((_, r) => {
      const controls = document.createElement('div');
      controls.className = 'sf-table__row-controls';
      controls.dataset.row = String(r);

      const drag = document.createElement('button');
      drag.type = 'button';
      drag.className = 'sf-table__drag';
      drag.setAttribute('aria-label', 'Drag row');
      drag.draggable = true;
      drag.innerHTML = renderIcon('GripVertical');
      drag.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(DRAG_MIME_ROW, String(r));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      controls.appendChild(drag);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.setAttribute('aria-label', 'Add row below');
      addBtn.innerHTML = renderIcon('Plus');
      addBtn.addEventListener('mousedown', (e) => e.preventDefault());
      addBtn.addEventListener('click', () => {
        this.mutateAndSync((t) => addRow(t, r + 1));
      });
      controls.appendChild(addBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', 'Delete row');
      delBtn.innerHTML = renderIcon('Trash');
      delBtn.addEventListener('mousedown', (e) => e.preventDefault());
      delBtn.addEventListener('click', () => {
        this.mutateAndSync((t) => deleteRow(t, r));
      });
      controls.appendChild(delBtn);

      // Position vertically relative to the corresponding row
      const tr = root.querySelectorAll('tbody tr')[r] as HTMLElement | undefined;
      if (tr) {
        controls.style.top = `${tr.offsetTop}px`;
      }
      root.appendChild(controls);
    });

    // Drag handlers for drop targets (delegated)
    this.attachDropHandlers(root);
  }

  private attachDropHandlers(root: HTMLElement): void {
    root.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      const isRow = e.dataTransfer.types.includes(DRAG_MIME_ROW);
      const isCol = e.dataTransfer.types.includes(DRAG_MIME_COL);
      if (!isRow && !isCol) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    root.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      const target = e.target as HTMLElement;
      if (e.dataTransfer.types.includes(DRAG_MIME_ROW)) {
        const fromStr = e.dataTransfer.getData(DRAG_MIME_ROW);
        const toRow = parseInt(
          (target.closest('tr') as HTMLElement | null)?.dataset.rowIndex ?? '-1',
          10,
        );
        const fromRow = parseInt(fromStr, 10);
        if (!Number.isNaN(fromRow) && toRow >= 0) {
          e.preventDefault();
          this.mutateAndSync((t) => moveRow(t, fromRow, toRow));
        }
      } else if (e.dataTransfer.types.includes(DRAG_MIME_COL)) {
        const fromStr = e.dataTransfer.getData(DRAG_MIME_COL);
        const th = target.closest('th') as HTMLElement | null;
        const td = target.closest('td') as HTMLElement | null;
        const colEl = th ?? td;
        const fromCol = parseInt(fromStr, 10);
        if (colEl && !Number.isNaN(fromCol)) {
          // Compute column index from cellIndex
          const row = colEl.parentElement as HTMLTableRowElement | null;
          if (row) {
            const toCol = Array.from(row.children).indexOf(colEl);
            if (toCol >= 0) {
              e.preventDefault();
              this.mutateAndSync((t) => moveColumn(t, fromCol, toCol));
            }
          }
        }
      }
    });
  }

  private updateColControlAlignments(t: ParsedTable): void {
    if (!this.dom) return;
    this.dom.querySelectorAll<HTMLElement>('.sf-table__col-controls').forEach((controls) => {
      const col = parseInt(controls.dataset.col ?? '-1', 10);
      if (col < 0) return;
      const alignBtn = controls.querySelector<HTMLElement>('[data-role="align"]');
      if (alignBtn) alignBtn.innerHTML = renderIcon(alignIconName(t.alignments[col] ?? 'left'));
    });
  }

  // --- Events ---------------------------------------------------------------

  private onCellFocus(): void {
    if (!this.view) return;
    this.view.dispatch({ effects: setTableFocusEffect.of(true) });
    this.view.dom.setAttribute('data-table-focused', 'true');
  }

  private onCellBlur(): void {
    if (!this.view) return;
    // Defer — if focus is moving to another cell within this table, keep table-focused
    window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && this.dom?.contains(active)) return;
      if (!this.view) return;
      this.view.dispatch({ effects: setTableFocusEffect.of(false) });
      this.view.dom.removeAttribute('data-table-focused');
    });
  }

  private onCellInput(row: number, col: number, el: HTMLElement): void {
    if (this.isComposing) return;
    const content = cellTextFromElement(el);
    this.table = setCellContent(this.table, row, col, content);
    this.scheduleSync();
  }

  private onCellKeydown(e: KeyboardEvent, row: number, col: number, el: HTMLElement): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      this.moveFocus(row, col, dir);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Flush any pending edit so the insert is based on fresh table
      this.flushSync();
      this.mutateAndSync((t) => addRow(t, row + 1));
      // Focus the new row's cell at same column
      queueMicrotask(() => this.focusCell(row + 1, col));
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      this.flushSync();
      // Move CM6 cursor to just after the table
      if (this.view) {
        this.view.dispatch({ selection: { anchor: this.to } });
        this.view.focus();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      if (!isCaretAtEnd(el)) return;
      e.preventDefault();
      this.moveFocus(row, col, +Infinity); // move to next row
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!isCaretAtStart(el)) return;
      e.preventDefault();
      this.moveFocus(row, col, -Infinity);
      return;
    }
  }

  private moveFocus(row: number, col: number, delta: number): void {
    const rowCount = this.table.rows.length;
    const colCount = this.table.headers.length;

    if (delta === +Infinity) {
      // ArrowDown: move to same column one row down
      if (row + 1 <= rowCount - 1) this.focusCell(row + 1, col);
      return;
    }
    if (delta === -Infinity) {
      // ArrowUp: move to same column one row up (or header)
      if (row > 0) this.focusCell(row - 1, col);
      else if (row === 0) this.focusCell(-1, col);
      else if (row === -1) {
        /* already at top */
      }
      return;
    }

    // Tab-linear navigation: headers → row 0 → row 1 → ... → append row
    let r = row,
      c = col;
    c += delta;
    if (c >= colCount) {
      c = 0;
      r += 1;
    } else if (c < 0) {
      c = colCount - 1;
      r -= 1;
    }

    if (r > rowCount - 1) {
      // Off the end — add a new row
      this.flushSync();
      this.mutateAndSync((t) => addRow(t, rowCount));
      queueMicrotask(() => this.focusCell(rowCount, 0));
      return;
    }
    if (r === -2) {
      // Off the top
      this.focusCell(-1, colCount - 1);
      return;
    }
    this.focusCell(r, c);
  }

  private focusCell(row: number, col: number): void {
    const el = row === -1 ? this.headerEls[col] : this.cellEls[row]?.[col];
    if (!el) return;
    el.focus();
    // Place caret at end
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // --- Sync ----------------------------------------------------------------

  private scheduleSync(): void {
    if (this.pendingSyncTimer != null) window.clearTimeout(this.pendingSyncTimer);
    this.pendingSyncTimer = window.setTimeout(() => {
      this.pendingSyncTimer = null;
      this.doSync();
    }, SYNC_DEBOUNCE_MS);
  }

  private flushSync(): void {
    if (this.pendingSyncTimer != null) {
      window.clearTimeout(this.pendingSyncTimer);
      this.pendingSyncTimer = null;
      this.doSync();
    }
  }

  /**
   * Resolve the current table markdown range via the DOM position, not by
   * widget identity. On every sync/rebuild CM6 creates a fresh widget instance
   * but the DOM element is reused — so looking up by widget becomes stale.
   * Using `view.posAtDOM(this.dom)` always hits the current range.
   */
  private currentRange(): { from: number; to: number } | null {
    if (!this.view || !this.dom) return null;
    const from = this.view.posAtDOM(this.dom);
    if (from < 0) return null;
    // Scan the Table node in the syntax tree at that position
    const tree = syntaxTree(this.view.state);
    let node = tree.resolveInner(from, 1);
    while (node && node.name !== 'Table') {
      if (!node.parent) return null;
      node = node.parent;
    }
    if (!node) return null;
    return { from: node.from, to: node.to };
  }

  private doSync(): void {
    if (!this.view) return;
    const newMd = serialize(this.table);
    const view = this.view;
    const range = this.currentRange();
    if (!range) return;
    if (view.state.sliceDoc(range.from, range.to) === newMd) return;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: newMd },
      userEvent: 'input.table-cell',
    });
  }

  /**
   * Run a table transform and immediately sync. Clears any pending text-input
   * debounce (so text edits are captured first).
   */
  private mutateAndSync(fn: (t: ParsedTable) => ParsedTable): void {
    this.flushSync();
    this.table = fn(this.table);
    if (!this.view) return;
    const newMd = serialize(this.table);
    const range = this.currentRange();
    if (!range) return;
    this.view.dispatch({
      changes: { from: range.from, to: range.to, insert: newMd },
      userEvent: 'input.table-structure',
    });
  }

  eq(other: TableEditorWidget): boolean {
    return other instanceof TableEditorWidget && other.sourceText === this.sourceText;
  }

  ignoreEvent(event: Event): boolean {
    // Let clicks/keys inside the widget stay inside; CM6 shouldn't try to move
    // its cursor into the table area when the widget is interactive.
    const t = event.target as HTMLElement | null;
    if (t && this.dom?.contains(t)) return true;
    return super.ignoreEvent?.(event) ?? false;
  }

  get estimatedHeight(): number {
    const headerHeight = 44;
    const rowHeight = 40;
    return headerHeight + this.table.rows.length * rowHeight + 16;
  }

  destroy(): void {
    if (this.pendingSyncTimer != null) {
      window.clearTimeout(this.pendingSyncTimer);
      this.pendingSyncTimer = null;
    }
  }
}

function alignIconName(a: Align): string {
  if (a === 'center') return 'AlignCenter';
  if (a === 'right') return 'AlignRight';
  return 'AlignLeft';
}

function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setStart(range.endContainer, range.endOffset);
  return probe.toString() === '';
}

function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString() === '';
}

// --- StateField: tableEditorField -----------------------------------------
//
// Builds block-replace decorations over every `Table` node in the doc. The
// widget instance created here is only used on FIRST mount; on subsequent
// updates CM6 calls `updateDOM` on a fresh widget instance, which harvests
// its state from the existing DOM. Ranges aren't tracked by widget identity
// anymore — the widget looks them up from the DOM via `view.posAtDOM`.

interface TableFieldValue {
  decorations: DecorationSet;
  treeLength: number;
  hasFocus: boolean;
}

// Tracks the editor's focus state inside the StateField so the
// reveal-source-on-cursor logic can ignore the default selection
// (cursor at 0,0 right after `setDoc`) when the editor isn't actually
// focused. Without this, a doc that starts with a table renders as
// raw markdown until the user clicks somewhere else.
const setTableFocus = StateEffect.define<boolean>();

function buildTableDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
  const tree = syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const from = node.from;
      const to = node.to;

      // Keep the source visible when the cursor is inside it — otherwise the
      // live-markdown decorations lose ground to the replacement widget.
      if (selectionRevealsRange(state, from, to, hasFocus)) return;

      const text = doc.sliceString(from, to);
      const widget = new TableEditorWidget(text, from, to);
      const deco = Decoration.replace({ widget, block: true });
      decos.push({ from, to, deco });
    },
  });

  decos.sort((a, b) => a.from - b.from);
  return RangeSet.of(decos.map((d) => d.deco.range(d.from, d.to)));
}

function selectionRevealsRange(
  state: EditorState,
  from: number,
  to: number,
  hasFocus: boolean,
): boolean {
  return selectionTouchesRange(hasFocus, state.selection.ranges, from, to);
}

const tableEditorField = StateField.define<TableFieldValue>({
  create(state): TableFieldValue {
    const tree = syntaxTree(state);
    return {
      decorations: buildTableDecorations(state, false),
      treeLength: tree.length,
      hasFocus: false,
    };
  },
  update(value, tr): TableFieldValue {
    const tree = syntaxTree(tr.state);
    const treeGrew = tree.length > value.treeLength;
    const refreshRequested = tr.effects.some((e) => e.is(liveMarkdownRefresh));
    const selectionNeedsRebuild = tr.selection && !isMarkdownSelectionRevealSuppressed();
    let hasFocus = value.hasFocus;
    let focusChanged = false;
    for (const ef of tr.effects) {
      if (ef.is(setTableFocus)) {
        if (ef.value !== hasFocus) focusChanged = true;
        hasFocus = ef.value;
      }
    }
    if (tr.docChanged || selectionNeedsRebuild || treeGrew || refreshRequested || focusChanged) {
      return {
        decorations: buildTableDecorations(tr.state, hasFocus),
        treeLength: tree.length,
        hasFocus,
      };
    }
    return { ...value, hasFocus };
  },
  provide(field) {
    return EditorView.decorations.from(field, (v) => v.decorations);
  },
});

const tableFocusTracker = EditorView.focusChangeEffect.of((_state, focusing) =>
  setTableFocus.of(focusing),
);

export const interactiveTableEditor = [tableEditorField, tableFocusTracker];
