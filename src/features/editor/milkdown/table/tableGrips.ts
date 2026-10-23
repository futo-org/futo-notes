/*
 * Row/column grips for GFM tables (QA lane 7 — Zvonimir: "no way to add new
 * columns, no way to delete rows or columns"; docs/spec/editor.md "Tables").
 *
 * Hovering a column shows a small grip above it; hovering a row shows one at
 * its left edge. Clicking a grip selects the whole row/column (a
 * `CellSelection`, so it is visibly highlighted the same way dragging across
 * cells already highlights them) and opens a 3-item menu: Insert before,
 * Insert after, Delete. Deleting the header row or the table's last
 * remaining row/column is DISABLED in the menu, not a silent no-op —
 * `tableCommands.ts` owns why, this only reads its reasons into a `title`
 * attribute and `disabled`.
 *
 * No edge "+" buttons: Insert after already covers that, and fewer
 * affordances is the point (Justin's scoping decision — full Obsidian
 * Advanced Tables parity is out, 2026-09).
 *
 * ARCHITECTURE: one `Plugin` view, mirroring `blockDragSession.ts`'s indicator — DOM
 * owned by this class, positioned `position: fixed` in viewport coordinates
 * (so no scroll compensation) and appended OUTSIDE the contenteditable
 * (`view.dom.parentNode`), for the same reason: WebKit's DOMObserver heals
 * foreign nodes inserted inside the editable back out again. Positions come
 * from the ACTUAL rendered table (`view.nodeDOM` + `<table>.rows`), not from
 * a NodeView wrapping the table's own DOM — prosemirror-tables' cell/column
 * DOM contract (and `columnResizing`, if ever added) is exact and easy to
 * break by wrapping it; measuring the existing element instead touches
 * nothing about how the table itself renders.
 *
 * Grips are position-addressed (row/column index resolved from the pointer
 * via `locateCell`, captured at hover time) rather than selection-addressed:
 * a grip click never moves the caret into the table first, so
 * `tableCommands.ts`'s commands take that position directly. See that file's
 * header for the one hazard this matters for (`addRow`'s ambiguous row
 * type at index 0).
 *
 * The exported `tableGrips` bundles this view with `tableLineBreak.ts`'s
 * Shift+Enter round-trip fix (a different table bug, mounted through the
 * same `.use(tableGrips)` call rather than a second one) — see that file for
 * why Shift+Enter in a table cell needed its own fix at all.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Command, type Transaction } from '@milkdown/kit/prose/state';
import { CellSelection } from '@milkdown/kit/prose/tables';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { localizedText } from '$shared/localization';
import { locateCell, type CellLocation } from './tableCommands';
import { clampRectToViewport, columnGripRect, rowGripRect, type Rect } from './tableGripsGeometry';
import { tableCellLineBreakRemark } from './tableLineBreak';
import { headerOnlyTablePaste, tablePasteRepair } from './tablePaste';
import { type GripKind, menuActionsFor, anchorPos, cellStartPos } from './tableGripMenu';
import {
  GRIP_CLASS,
  GRIP_COL_CLASS,
  GRIP_ROW_CLASS,
  MENU_CLASS,
  MENU_ITEM_CLASS,
  GRIP_SIZE,
  GRIP_GAP,
  domRect,
  tableElementFor,
  applyRect,
  isNearGrip,
} from './tableGripsDom';
export { isNearGrip } from './tableGripsDom';

export const tableGripsKey = new PluginKey<number>('FUTO_TABLE_GRIPS');

/** Hides the grips with `tr`. A touch places them through the emulated mouse
 * events a tap sends, and never sends the `mouseleave` that hides them again,
 * so the mobile shells' keyboard dismiss clears them explicitly. */
export function hideTableGrips(tr: Transaction): Transaction {
  return tr.setMeta(tableGripsKey, 'hide');
}

/** Owns the two grip buttons and the menu popover for one editor view. */
class TableGripsView {
  private readonly view: ProseView;
  private readonly doc: Document;
  private colGrip: HTMLButtonElement | null = null;
  private rowGrip: HTMLButtonElement | null = null;
  private menu: HTMLDivElement | null = null;
  /** The row/column the currently-shown grips (and, once opened, the menu)
   * belong to. Frozen while the menu is open so moving the pointer toward
   * the menu's buttons cannot swap out the grip underneath it. */
  private current: { loc: CellLocation; colRect: Rect; rowRect: Rect } | null = null;
  private menuOpenFor: GripKind | null = null;

  constructor(view: ProseView) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    view.dom.addEventListener('mousemove', this.onMouseMove);
    view.dom.addEventListener('mouseleave', this.onMouseLeave);
  }

  destroy(): void {
    this.view.dom.removeEventListener('mousemove', this.onMouseMove);
    this.view.dom.removeEventListener('mouseleave', this.onMouseLeave);
    this.closeMenu();
    this.colGrip?.remove();
    this.rowGrip?.remove();
    this.menu?.remove();
  }

  /**
   * Closes and hides on any doc change. `this.current`'s positions
   * (`tableStart`, row/col indices) are numbers captured against the OLD
   * document; a transaction can shift or invalidate every one of them
   * (insert/delete anywhere, not just in this table), and neither `Plugin`'s
   * `update` hook nor this class maps them through `tr.mapping`. Recomputing
   * from a stale position risks silently pointing at the wrong table rather
   * than failing loudly, so this takes the simple, correct way out: drop the
   * pinned grips and let the next `mousemove` re-resolve them fresh. A
   * mutation from THIS plugin's own menu already calls `closeMenu` itself;
   * this is what catches every other doc change (typing, another plugin,
   * undo/redo) while a grip happens to be showing.
   */
  update(_view: ProseView, prevState: ProseView['state']): void {
    const hideRequested =
      tableGripsKey.getState(this.view.state) !== tableGripsKey.getState(prevState);
    if (this.view.state.doc === prevState.doc && !hideRequested) return;
    this.closeMenu();
    this.hideGrips();
  }

  private onMouseMove = (event: MouseEvent): void => {
    if (this.menuOpenFor) return; // frozen until the menu closes
    const { clientX, clientY } = event;
    // The grips sit OUTSIDE the table (above/left of it), so the pointer's
    // path from a cell to the grip crosses ground `posAtCoords` cannot
    // resolve into any cell. Without this, the grip would vanish the instant
    // the pointer left the table on its way to being clicked. Keep showing
    // the current grips while the pointer is within their (generously
    // expanded) own hit zone; only re-resolve once it is neither over a cell
    // nor near a grip.
    if (
      this.current &&
      (isNearGrip(clientX, clientY, this.current.colRect) ||
        isNearGrip(clientX, clientY, this.current.rowRect))
    ) {
      return;
    }
    const pos = this.view.posAtCoords({ left: clientX, top: clientY })?.pos;
    const loc = pos === undefined ? null : locateCell(this.view.state, pos);
    if (!loc) {
      this.hideGrips();
      return;
    }
    this.positionGrips(loc);
  };

  /**
   * The grip buttons are appended as SIBLINGS of `view.dom`, not descendants
   * (see the file header) — so the instant the pointer crosses from a cell
   * onto a grip, the browser fires `mouseleave` on `view.dom` itself (the
   * pointer genuinely left it and everything inside it). Hiding
   * unconditionally here raced exactly that: the grip vanished the moment a
   * real click's own hover-then-press sequence moved onto it, so nothing was
   * ever clickable in a real browser (only jsdom-free unit math could not
   * have caught this — found by the Playwright spec). `relatedTarget` is
   * where the pointer is going; if that is one of THIS plugin's own
   * elements, the pointer has not actually left the table's controls.
   */
  private onMouseLeave = (event: MouseEvent): void => {
    if (this.menuOpenFor) return;
    const goingTo = event.relatedTarget;
    if (goingTo instanceof Node && this.ownsElement(goingTo)) return;
    this.hideGrips();
  };

  private ownsElement(node: Node): boolean {
    return (
      (this.colGrip?.contains(node) ?? false) ||
      (this.rowGrip?.contains(node) ?? false) ||
      (this.menu?.contains(node) ?? false)
    );
  }

  private ensureColGrip(): HTMLButtonElement {
    if (!this.colGrip) {
      const el = this.doc.createElement('button');
      el.type = 'button';
      el.className = `${GRIP_CLASS} ${GRIP_COL_CLASS}`;
      el.setAttribute(
        'aria-label',
        localizedText('editor.tableGrips.columnOptionsAccessibilityLabel'),
      );
      el.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.current) this.openMenu('col', this.current.loc);
      });
      (this.view.dom.parentNode ?? this.doc.body).appendChild(el);
      this.colGrip = el;
    }
    return this.colGrip;
  }

  private ensureRowGrip(): HTMLButtonElement {
    if (!this.rowGrip) {
      const el = this.doc.createElement('button');
      el.type = 'button';
      el.className = `${GRIP_CLASS} ${GRIP_ROW_CLASS}`;
      el.setAttribute(
        'aria-label',
        localizedText('editor.tableGrips.rowOptionsAccessibilityLabel'),
      );
      el.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.current) this.openMenu('row', this.current.loc);
      });
      (this.view.dom.parentNode ?? this.doc.body).appendChild(el);
      this.rowGrip = el;
    }
    return this.rowGrip;
  }

  private positionGrips(loc: CellLocation): void {
    const table = tableElementFor(this.view, loc);
    if (!table) {
      this.hideGrips();
      return;
    }
    const headerCell = table.rows[0]?.cells[loc.left];
    const rowEl = table.rows[loc.top];
    if (!headerCell || !rowEl) {
      this.hideGrips();
      return;
    }
    // Clamped into the viewport: a table with nothing above it (the common
    // case — the first block in a note) would otherwise place the column
    // grip at a negative `top`, off-screen and unclickable; a table flush to
    // the left edge does the same to the row grip's `left`. See
    // `clampRectToViewport`'s own comment.
    const viewportWidth = this.doc.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY;
    const viewportHeight = this.doc.defaultView?.innerHeight ?? Number.POSITIVE_INFINITY;
    const colRect = clampRectToViewport(
      columnGripRect(domRect(headerCell), GRIP_SIZE, GRIP_GAP),
      viewportWidth,
      viewportHeight,
    );
    const rowRect = clampRectToViewport(
      rowGripRect(domRect(rowEl), GRIP_SIZE, GRIP_GAP),
      viewportWidth,
      viewportHeight,
    );
    this.current = { loc, colRect, rowRect };

    const col = this.ensureColGrip();
    applyRect(col, colRect);
    col.hidden = false;

    const row = this.ensureRowGrip();
    applyRect(row, rowRect);
    row.hidden = false;
  }

  private hideGrips(): void {
    if (this.colGrip) this.colGrip.hidden = true;
    if (this.rowGrip) this.rowGrip.hidden = true;
    this.current = null;
  }

  private openMenu(kind: GripKind, loc: CellLocation): void {
    this.menuOpenFor = kind;
    const pos = anchorPos(loc, kind);
    const actions = menuActionsFor(kind, pos, loc);
    const anchorRect = kind === 'col' ? this.current!.colRect : this.current!.rowRect;

    const menu = this.ensureMenu();
    // Not `replaceChildren()` (Chromium 86) — the editor's floor is Chromium 80
    // (tests/editor-embed-webview-floor.spec.ts). `textContent = ''` clears the
    // same way and predates the floor by a decade.
    menu.textContent = '';
    for (const action of actions) {
      const item = this.doc.createElement('button');
      item.type = 'button';
      item.className = MENU_ITEM_CLASS;
      item.textContent = action.label;
      item.disabled = action.disabled;
      if (action.disabledReason) item.title = action.disabledReason;
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Select the row/column first (visible highlight), then run the
        // command against the LIVE state — the selection dispatch and the
        // structural edit are two transactions, which is fine here: nothing
        // between them is user-visible, and undo coalescing is Milkdown's.
        this.selectThenRun(kind, loc, action.run);
        this.closeMenu();
      });
      menu.appendChild(item);
    }
    menu.hidden = false;
    // Anchored to the grip's own box: to its right for a column grip (which
    // sits above the table, so a menu below it stays clear of the table),
    // below for a row grip (which sits to the table's left).
    menu.style.left = `${anchorRect.left}px`;
    menu.style.top = `${anchorRect.top + anchorRect.height + GRIP_GAP}px`;

    this.doc.addEventListener('mousedown', this.onDocumentMouseDown, true);
    this.doc.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  private selectThenRun(kind: GripKind, loc: CellLocation, run: Command): void {
    const { view } = this;
    const anchor = cellStartPos(loc, kind);
    const $anchor = view.state.doc.resolve(Math.min(anchor, view.state.doc.content.size));
    const selection =
      kind === 'row' ? CellSelection.rowSelection($anchor) : CellSelection.colSelection($anchor);
    view.dispatch(view.state.tr.setSelection(selection));
    run(view.state, view.dispatch);
    view.focus();
  }

  private closeMenu(): void {
    if (!this.menuOpenFor) return;
    this.menuOpenFor = null;
    if (this.menu) this.menu.hidden = true;
    this.doc.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    this.doc.removeEventListener('keydown', this.onDocumentKeyDown, true);
  }

  private onDocumentMouseDown = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Node && this.menu?.contains(target)) return;
    this.closeMenu();
    this.hideGrips();
  };

  private onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeMenu();
      this.hideGrips();
    }
  };

  private ensureMenu(): HTMLDivElement {
    if (!this.menu) {
      const el = this.doc.createElement('div');
      el.className = MENU_CLASS;
      el.setAttribute('role', 'menu');
      (this.view.dom.parentNode ?? this.doc.body).appendChild(el);
      this.menu = el;
    }
    return this.menu;
  }
}

const tableGripsView = $prose(
  () =>
    new Plugin({
      key: tableGripsKey,
      // Counts `hideTableGrips` requests; the view hides on any change.
      state: {
        init: () => 0,
        apply: (tr, requests: number) =>
          tr.getMeta(tableGripsKey) === 'hide' ? requests + 1 : requests,
      },
      view: (view) => new TableGripsView(view),
    }),
);

/**
 * Everything `editorPlugins.ts`'s one `.use(tableGrips)` needs to mount
 * for GFM tables: the grips view above, plus the reader half of the
 * Shift+Enter line-break round trip (`tableLineBreak.ts` — a different bug in
 * the same feature area, bundled here rather than adding a second `.use()`
 * call), and the table-paste repair (`tablePaste.ts`), mirroring how
 * `wikilink/index.ts` bundles its own feature's plugins under one name.
 */
export const tableGrips = [
  tableGripsView,
  tableCellLineBreakRemark,
  headerOnlyTablePaste,
  tablePasteRepair,
].flat();
