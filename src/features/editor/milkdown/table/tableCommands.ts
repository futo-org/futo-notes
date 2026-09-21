/*
 * GFM table structure commands (QA lane 7 / Zvonimir's "no way to add new
 * columns, no way to delete rows or columns" finding — docs/spec/editor.md
 * "Tables"): insert/delete a row or column. Full Obsidian Advanced Tables
 * parity is explicitly out of scope (Justin, see the spec Gap line) — this is
 * only structural mutation, addressed by row/column index.
 *
 * Every command is POSITION-ADDRESSED rather than selection-addressed:
 * `state.selection` never enters into it. The caller is `tableGrips.ts`'s
 * grip menu, and a grip click never moves the caret into the row/column it
 * targets (the pointer is over a grip button outside the table, not over a
 * cell) — see that file's header. A position anywhere inside the target
 * cell's subtree is enough; `locateCell` walks up from it to the table.
 *
 * PRIMITIVES, all from `prosemirror-tables` via `@milkdown/kit/prose/tables`:
 * `TableMap` (the row/col grid), `cellAround` (resolve a position to its
 * cell), `addRow`/`addColumn` (insert with correct per-row cell typing),
 * `removeRow`/`removeColumn` (delete with colspan/rowspan bookkeeping). Row
 * and column insertion/deletion are NOT hand-rolled — these primitives
 * already know how to grow/shrink merged cells correctly.
 *
 * `addRowBefore`/`addRowAfter` — the ready-made prosemirror-tables COMMANDS,
 * as opposed to the `addRow` transaction-builder used here — are
 * deliberately NOT used for rows. They pick the new row's node type off
 * `tableNodeTypes(schema).row`, which this schema resolves ambiguously:
 * `table_header_row` and `table_row` both declare `tableRole: 'row'`
 * (`__fixtures__/schema.ts`'s registration-order comment; confirmed against
 * `@milkdown/preset-gfm`'s own node/table/schema.ts, which registers
 * `table_header_row` before `table_row`), so `tableNodeTypes` — a last-write
 * map keyed by role — resolves `.row` to the BODY type. `addRow` always
 * creates that type regardless of target index, so inserting at row index 0
 * (a row "above" the header) would insert a `table_row` where the schema's
 * `content: "table_header_row table_row+"` requires the header. This module
 * never lets that happen: `insertRowBefore` on the header row (index 0) is
 * refused (see `rowMenuState`), so `addRow`'s target index is always >= 1,
 * which is always a body position. `addColumn` has no equivalent hazard — it
 * picks each row's cell type by copying the NEIGHBOURING cell in the SAME
 * row, so it produces a `table_header` in the header row and a `table_cell`
 * everywhere else without this module telling it which is which.
 *
 * Deleting the table's last remaining row or column is a documented product
 * decision (not the same as a prior draft of this feature): it is a NO-OP,
 * not a whole-table delete. `content: "table_header_row table_row+"` forbids
 * a header with zero body rows, and a table with zero columns is nonsense —
 * so both guards simply refuse rather than doing anything destructive.
 */
import { localizedText } from '$shared/localization';
import type { Command, EditorState } from '@milkdown/kit/prose/state';
import {
  addColumn,
  addRow,
  cellAround,
  removeColumn,
  removeRow,
  TableMap,
  type TableRect,
} from '@milkdown/kit/prose/tables';

/** One resolved cell's row/column position within its table, shaped as a
 * `TableRect` (the cell's own left/top/right/bottom, plus its table's
 * `map`/`tableStart`/`table`) because that is exactly what every
 * `prosemirror-tables` primitive imported above expects. */
export type CellLocation = TableRect;

/**
 * The table cell whose subtree contains `pos`, or null when `pos` is not
 * inside one — the position is stale (the table was edited or removed since
 * the grip was rendered) or simply outside any table.
 *
 * `pos` need not be the cell's own start: `cellAround` walks UP from it
 * looking for a `tableRole: 'row'` ancestor and returns the cell one level
 * in, so anywhere inside the cell's subtree resolves to the same cell.
 */
export function locateCell(state: EditorState, pos: number): CellLocation | null {
  const bounded = Math.max(0, Math.min(pos, state.doc.content.size));
  const $cell = cellAround(state.doc.resolve(bounded));
  if (!$cell) return null;
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - tableStart);
  return { ...rect, tableStart, map, table };
}

/** The table node's own document position (before its opening tag) — one
 * less than `tableStart`, which is `prosemirror-tables`' convention for the
 * position of the table's first child. Used to find the table's rendered DOM
 * (`view.nodeDOM`) from a `CellLocation`. */
export function tablePosOf(loc: CellLocation): number {
  return loc.tableStart - 1;
}

/** Row 0 is always the header (`content: "table_header_row table_row+"`). */
export function isHeaderRow(loc: CellLocation): boolean {
  return loc.top === 0;
}

/** Whether a row may be inserted BEFORE the row at `loc` — refused only for
 * the header, which must stay the table's first row. */
export function canInsertRowBefore(loc: CellLocation): boolean {
  return !isHeaderRow(loc);
}

/** Whether the row at `loc` may be deleted: never the header, and never the
 * table's last body row (`map.height` counts the header too, so `<= 2` means
 * at most one body row remains). */
export function canDeleteRow(loc: CellLocation): boolean {
  return !isHeaderRow(loc) && loc.map.height > 2;
}

/** Whether the column at `loc` may be deleted: never the table's last
 * column. */
export function canDeleteColumn(loc: CellLocation): boolean {
  return loc.map.width > 1;
}

/** Human-readable reason a disabled row action is disabled, for the grip
 * menu to show rather than silently no-op (product requirement: a disabled
 * control must say why). Null when the action is allowed. */
export function rowDeleteDisabledReason(loc: CellLocation): string | null {
  if (isHeaderRow(loc)) return localizedText('editor.tableGrips.headerRowCannotBeDeleted');
  if (loc.map.height <= 2) return localizedText('editor.tableGrips.needsAtLeastOneRow');
  return null;
}

/** Same contract as {@link rowDeleteDisabledReason}, for a column. */
export function columnDeleteDisabledReason(loc: CellLocation): string | null {
  if (loc.map.width <= 1) return localizedText('editor.tableGrips.needsAtLeastOneColumn');
  return null;
}

/** Insert a row above the row at `pos`. Refused on the header row (see the
 * file header's `addRow` hazard) — callers must not offer this action there;
 * `rowMenuState`/`canInsertRowBefore` is what the grip menu checks. */
export function insertRowBefore(pos: number): Command {
  return (state, dispatch) => {
    const loc = locateCell(state, pos);
    if (!loc || !canInsertRowBefore(loc)) return false;
    if (!dispatch) return true;
    dispatch(addRow(state.tr, loc, loc.top).scrollIntoView());
    return true;
  };
}

/** Insert a row below the row at `pos`. Always allowed — inserting after the
 * header (index 0) lands at index 1, a body position, so it never hits the
 * `addRow` hazard either. */
export function insertRowAfter(pos: number): Command {
  return (state, dispatch) => {
    const loc = locateCell(state, pos);
    if (!loc) return false;
    if (!dispatch) return true;
    dispatch(addRow(state.tr, loc, loc.top + 1).scrollIntoView());
    return true;
  };
}

/** Insert a column to the left of the column at `pos`. Valid from either a
 * header or a body cell — `addColumn` has no header/body hazard. */
export function insertColumnBefore(pos: number): Command {
  return (state, dispatch) => {
    const loc = locateCell(state, pos);
    if (!loc) return false;
    if (!dispatch) return true;
    dispatch(addColumn(state.tr, loc, loc.left).scrollIntoView());
    return true;
  };
}

/** Insert a column to the right of the column at `pos`. */
export function insertColumnAfter(pos: number): Command {
  return (state, dispatch) => {
    const loc = locateCell(state, pos);
    if (!loc) return false;
    if (!dispatch) return true;
    dispatch(addColumn(state.tr, loc, loc.left + 1).scrollIntoView());
    return true;
  };
}

/**
 * Delete the row at `pos`. A no-op (returns false, dispatches nothing) on
 * the header row or the table's last body row — see {@link canDeleteRow}.
 * Deleting the last row does NOT delete the whole table: the table must
 * never become malformed, and it must never vanish out from under the user
 * either.
 */
export function deleteRowAt(pos: number): Command {
  return (state, dispatch) => {
    const loc = locateCell(state, pos);
    if (!loc || !canDeleteRow(loc)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    removeRow(tr, loc, loc.top);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Delete the column at `pos`. A no-op on the table's last column — see
 * {@link canDeleteColumn}. */
export function deleteColumnAt(pos: number): Command {
  return (state, dispatch) => {
    const loc = locateCell(state, pos);
    if (!loc || !canDeleteColumn(loc)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    removeColumn(tr, loc, loc.left);
    dispatch(tr.scrollIntoView());
    return true;
  };
}
