import { WidgetType, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parseMarkdownTable } from './tableModel';
import type { ParsedTable } from './tableModel';
import { addRow, serialize, setCellContent } from './tableOperations';
import { setTableFocusEffect } from '../editorUX/selectionToolbar';
import { attachTableControls, updateTableControlAlignments } from './tableControls';
import { createTableCellNavigation } from './tableCellNavigation';

const SYNC_DEBOUNCE_MS = 180;

function cellTextFromElement(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\r?\n/g, ' ');
}

export class TableEditorWidget extends WidgetType {
  readonly from: number;
  readonly to: number;
  readonly sourceText: string;
  private table: ParsedTable;
  private dom: HTMLElement | null = null;
  private cellEls: HTMLElement[][] = [];
  private headerEls: HTMLElement[] = [];
  private pendingSyncTimer: number | null = null;
  private isComposing = false;
  private view: EditorView | null = null;
  private readonly cellNavigation = createTableCellNavigation({
    getTable: () => this.table,
    getHeaderCells: () => this.headerEls,
    getBodyCells: () => this.cellEls,
    flushPendingSync: () => this.flushSync(),
    addRow: (rowIndex) => this.mutateAndSync((table) => addRow(table, rowIndex)),
    leaveTable: () => {
      if (!this.view) return;
      this.view.dispatch({ selection: { anchor: this.to } });
      this.view.focus();
    },
  });

  constructor(sourceText: string, from: number, to: number) {
    super();
    this.sourceText = sourceText;
    this.from = from;
    this.to = to;
    const parsed = parseMarkdownTable(sourceText);
    this.table = parsed ?? { headers: [], rows: [], alignments: [] };
  }

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
      const next = e.relatedTarget as Node | null;
      if (next && root.contains(next)) return;
      scheduleHide();
    });
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.view = view;
    this.dom = dom;
    const table = dom.querySelector('table');
    if (!table) return false;
    this.adoptExistingDom(dom);
    this.renderInto(dom, table as HTMLTableElement);
    return true;
  }

  private adoptExistingDom(root: HTMLElement): void {
    const ths = root.querySelectorAll<HTMLElement>('thead .sf-table__cell');
    this.headerEls = Array.from(ths);
    const trs = root.querySelectorAll<HTMLElement>('tbody tr');
    this.cellEls = Array.from(trs).map((tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>('.sf-table__cell')),
    );
  }

  private renderInto(root: HTMLElement, table: HTMLTableElement): void {
    const t = this.table;
    const prevRowCount = this.cellEls.length;
    const prevColCount = this.headerEls.length;
    const rowCount = t.rows.length;
    const colCount = t.headers.length;
    const structural = prevRowCount !== rowCount || prevColCount !== colCount;

    if (structural) {
      // textContent = '' (not replaceChildren, which is Chromium 86) so the
      // table rebuild runs on older Android WebViews too (github#8).
      table.textContent = '';
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
    align: ParsedTable['alignments'][number],
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
    div.addEventListener('keydown', (event) =>
      this.cellNavigation.handleKeydown(event, row, col, div),
    );
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

  private attachOverlays(root: HTMLElement): void {
    attachTableControls({
      root,
      table: this.table,
      mutateTable: (mutation) => this.mutateAndSync(mutation),
    });
  }

  private updateColControlAlignments(t: ParsedTable): void {
    if (!this.dom) return;
    updateTableControlAlignments(this.dom, t);
  }

  private onCellFocus(): void {
    if (!this.view) return;
    this.view.dispatch({ effects: setTableFocusEffect.of(true) });
    this.view.dom.setAttribute('data-table-focused', 'true');
  }

  private onCellBlur(): void {
    if (!this.view) return;
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

  private currentRange(): { from: number; to: number } | null {
    if (!this.view || !this.dom) return null;
    const from = this.view.posAtDOM(this.dom);
    if (from < 0) return null;
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
