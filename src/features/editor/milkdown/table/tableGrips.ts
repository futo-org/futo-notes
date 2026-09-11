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
 * Advanced Tables parity is out, see the spec Gap line).
 *
 * ARCHITECTURE: one `Plugin` view, mirroring `blockDropIndicator.ts` — DOM
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
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Command } from '@milkdown/kit/prose/state';
import { CellSelection } from '@milkdown/kit/prose/tables';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import {
  canInsertRowBefore,
  columnDeleteDisabledReason,
  deleteColumnAt,
  deleteRowAt,
  insertColumnAfter,
  insertColumnBefore,
  insertRowAfter,
  insertRowBefore,
  locateCell,
  rowDeleteDisabledReason,
  tablePosOf,
  type CellLocation,
} from './tableCommands';
import {
  clampRectToViewport,
  columnGripRect,
  expandRect,
  pointInRect,
  rowGripRect,
  type Rect,
} from './tableGripsGeometry';

export const tableGripsKey = new PluginKey('FUTO_TABLE_GRIPS');

const GRIP_CLASS = 'futo-table-grip';
const GRIP_COL_CLASS = 'futo-table-grip-col';
const GRIP_ROW_CLASS = 'futo-table-grip-row';
const MENU_CLASS = 'futo-table-grip-menu';
const MENU_ITEM_CLASS = 'futo-table-grip-menu-item';

/** CSS px. Small on purpose (desktop, mouse-first) — the brief for this lane
 * notes touch targets this size are a known rough edge for fingers rather
 * than something to redesign here; see docs/spec/editor.md's Gap line. */
const GRIP_SIZE = 18;
const GRIP_GAP = 4;
/** How far past a grip's own box the pointer may wander and still count as
 * "hovering it", so the grip does not vanish the instant the pointer nears
 * its edge on the way to clicking it. */
const GRIP_HOVER_MARGIN = 10;

type GripKind = 'row' | 'col';

interface MenuAction {
  label: string;
  disabled: boolean;
  disabledReason: string | null;
  run: Command;
}

/** The three menu entries for whichever grip was clicked, in the fixed
 * order the spec calls for. */
function menuActionsFor(kind: GripKind, pos: number, loc: CellLocation): MenuAction[] {
  if (kind === 'row') {
    const insertBeforeAllowed = canInsertRowBefore(loc);
    const deleteReason = rowDeleteDisabledReason(loc);
    return [
      {
        label: 'Insert before',
        disabled: !insertBeforeAllowed,
        disabledReason: insertBeforeAllowed ? null : 'The header row must stay first.',
        run: insertRowBefore(pos),
      },
      { label: 'Insert after', disabled: false, disabledReason: null, run: insertRowAfter(pos) },
      {
        label: 'Delete',
        disabled: deleteReason !== null,
        disabledReason: deleteReason,
        run: deleteRowAt(pos),
      },
    ];
  }
  const deleteReason = columnDeleteDisabledReason(loc);
  return [
    { label: 'Insert before', disabled: false, disabledReason: null, run: insertColumnBefore(pos) },
    { label: 'Insert after', disabled: false, disabledReason: null, run: insertColumnAfter(pos) },
    {
      label: 'Delete',
      disabled: deleteReason !== null,
      disabledReason: deleteReason,
      run: deleteColumnAt(pos),
    },
  ];
}

/** The first cell in the target row/column, as (row, col) into the table's
 * grid. Shared by {@link anchorPos} and {@link cellStartPos} so the two
 * position conventions below always agree on WHICH cell. */
function firstCellOf(loc: CellLocation, kind: GripKind): { row: number; col: number } {
  return kind === 'row' ? { row: loc.top, col: 0 } : { row: 0, col: loc.left };
}

/** The document position `tableCommands.ts` should act on for `loc`: any
 * position inside the target row/column's first cell in that line —
 * `locateCell`/`cellAround` resolve the same cell from anywhere in its
 * subtree, so one step inside its opening tag is enough and keeps this off
 * the boundary (never resolving to the PRECEDING cell instead). */
function anchorPos(loc: CellLocation, kind: GripKind): number {
  const { row, col } = firstCellOf(loc, kind);
  return loc.tableStart + loc.map.positionAt(row, col, loc.table) + 1;
}

/**
 * The exact cell-start position `CellSelection.rowSelection`/`colSelection`
 * require: NO offset into the cell. Its constructor reads `$anchorCell.node(-1)`
 * expecting the TABLE — one past the boundary would resolve one depth too
 * deep (inside the cell's own content) and hand it the CELL instead,
 * throwing when `TableMap.get` is called on a non-table node. This is a
 * different position than `anchorPos` on purpose, not the same value reused.
 */
function cellStartPos(loc: CellLocation, kind: GripKind): number {
  const { row, col } = firstCellOf(loc, kind);
  return loc.tableStart + loc.map.positionAt(row, col, loc.table);
}

function domRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** The actual rendered `<table>` for `loc`, or null if the view has nothing
 * at that position (the table was just removed). */
function tableElementFor(view: ProseView, loc: CellLocation): HTMLTableElement | null {
  const dom = view.nodeDOM(tablePosOf(loc));
  return dom instanceof HTMLTableElement ? dom : null;
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
    this.doc.removeEventListener('mousedown', this.onDocumentMouseDown, true);
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
    if (this.view.state.doc === prevState.doc) return;
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
      el.setAttribute('aria-label', 'Column options');
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
      el.setAttribute('aria-label', 'Row options');
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
    menu.replaceChildren();
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

function applyRect(el: HTMLElement, rect: Rect): void {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

/** Re-exported for tests that want to check hit-testing without a live view. */
export function isNearGrip(x: number, y: number, gripRect: Rect): boolean {
  return pointInRect(x, y, expandRect(gripRect, GRIP_HOVER_MARGIN));
}

export const tableGrips = $prose(
  () =>
    new Plugin({
      key: tableGripsKey,
      view: (view) => new TableGripsView(view),
    }),
);
