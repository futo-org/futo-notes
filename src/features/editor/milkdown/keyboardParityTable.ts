import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import {
  addRow,
  CellSelection,
  isInTable,
  selectedRect,
  TableMap,
  type TableRect,
} from '@milkdown/kit/prose/tables';

/**
 * The cell rect of a cursor/text selection inside one table cell, or null for
 * anything this module should leave alone (not in a table, or a
 * prosemirror-tables CellSelection spanning whole cells).
 */
function cursorCellRect(state: EditorState): TableRect | null {
  if (!isInTable(state)) return null;
  if (state.selection instanceof CellSelection) return null;
  return selectedRect(state);
}

/** Add a row at `rowIndex` and put the caret in its `column`-th cell. */
function addRowWithCaret(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  rect: TableRect,
  rowIndex: number,
  column: number,
): boolean {
  if (!dispatch) return true;
  const tr = addRow(state.tr, rect, rowIndex);
  // The row landed inside the table, so the table's own position is unmoved;
  // re-read the node to get a map that includes the new row.
  const table = tr.doc.nodeAt(rect.tableStart - 1) as ProseNode;
  const map = TableMap.get(table);
  const cellPos = rect.tableStart + map.positionAt(rowIndex, column, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1), 1));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Move into `(rowIndex, column)` of the SAME table, without changing the
 * document — the not-last-row half of {@link insertTableRowBelow}. `rect` is
 * still valid to read from directly since nothing has mapped it: no
 * transaction has touched the doc yet.
 *
 * Selects the WHOLE cell content rather than dropping a bare caret, matching
 * `goToNextCell`'s own convention (Tab already does this — "goToNextCell
 * selects the cell, typing replaces", tests/editor-embed-milkdown-interactive.spec.ts).
 * A bare caret would have to pick a side of any existing text to land on,
 * which Tab does not have to choose and Enter should not disagree with it
 * over.
 */
function moveCaretToCell(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  rect: TableRect,
  rowIndex: number,
  column: number,
): boolean {
  if (!dispatch) return true;
  const cellPos = rect.tableStart + rect.map.positionAt(rowIndex, column, rect.table);
  const cellNode = state.doc.nodeAt(cellPos);
  if (!cellNode) return false;
  const $cell = state.doc.resolve(cellPos);
  const $afterCell = state.doc.resolve(cellPos + cellNode.nodeSize);
  const tr = state.tr.setSelection(TextSelection.between($cell, $afterCell));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Enter in a table cell: move the caret down to the same column of the row
 * below — GFM cells are single-line, so Enter must never insert a line break
 * inside one, and this always fully handles the key (never falls through to
 * a default paragraph split). Only on the LAST row, where there is no row
 * below, does this insert one and move into it instead — the only case that
 * still creates a row. A header cell is never the last row (the schema
 * requires at least one body row), so Enter there always lands in the first
 * body row rather than inserting a second header.
 */
export const insertTableRowBelow: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  if (rect.top >= rect.map.height - 1) {
    return addRowWithCaret(state, dispatch, rect, rect.top + 1, rect.left);
  }
  return moveCaretToCell(state, dispatch, rect, rect.top + 1, rect.left);
};

/**
 * Shift+Enter in a table cell: insert a real line break IN the cell, instead
 * of falling through to the preset's own hardbreak handling — which the
 * preset's `hardbreakFilterPlugin` REJECTS outright inside a table (ctx
 * `hardbreakFilterNodes` defaults to `["table", "code_block"]`,
 * `@milkdown/preset-commonmark`'s `hardbreak-filter-plugin.ts`), so the key
 * silently did nothing at all and the very next keystroke landed right where
 * the caret already was: `r1a`, Shift+Enter, `second` saved as `r1asecond`,
 * fusing the two halves with no separator whatsoever. The filter only
 * inspects transactions carrying the `hardbreak` meta the preset's own
 * `insertHardbreakCommand` sets before dispatch, so building the transaction
 * directly here — and never setting that meta — sails past it undetected.
 * `table/tableLineBreak.ts` owns the two markdown round-trip halves this
 * needs on top (a GFM table cell is one line and cannot hold a literal
 * newline, so the break has to serialize as `<br>` and parse back the same
 * way).
 */
export const insertLineBreakInTableCell: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  const hardbreak = state.schema.nodes.hardbreak;
  if (!hardbreak) return false;
  if (!dispatch) return true;
  dispatch(state.tr.replaceSelectionWith(hardbreak.create()).scrollIntoView());
  return true;
};

/**
 * Tab in the very LAST cell: append a row and put the caret in its first
 * cell — the wrap-around the preset's `goToNextCell` has nowhere to go for.
 * Anywhere else it declines, leaving Tab to the preset's cell navigation.
 */
export const appendTableRowFromLastCell: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  const { map } = rect;
  if (rect.top !== map.height - 1 || rect.left !== map.width - 1) return false;
  return addRowWithCaret(state, dispatch, rect, map.height, 0);
};
