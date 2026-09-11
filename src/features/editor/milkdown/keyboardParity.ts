/*
 * Keyboard parity with the CodeMirror editor's interactive elements
 * (docs/spec/editor.md "Interactive elements", issue #108):
 *
 * - Enter in a table cell moves the caret down to the same column of the row
 *   below; only on the LAST row — where there is no row below — does it
 *   append a new one and move into that instead (QA lane 7, 2026-09:
 *   "Enter will create new row" no matter where the caret was, the previous
 *   behavior here, was the reported bug). The grip menu
 *   (`table/tableGrips.ts`) is the deliberate replacement for adding a row
 *   anywhere but the end, since the native shells have no right-click cell
 *   context menu. The gfm preset instead bound bare Enter to `exitTable`,
 *   which dropped a stray empty paragraph after the table.
 * - Tab at the very last cell appends a row (mirroring the CodeMirror
 *   `tableCellNavigation` wrap-around) instead of falling through to the
 *   browser's default Tab, which moved focus out of the editor and silently
 *   swallowed whatever was typed next.
 * - Splitting a checked task item starts the new item UNCHECKED, the same as
 *   the CodeMirror `listContinuation` rule — ProseMirror's `splitListItem`
 *   otherwise clones the `checked: true` attr onto the new item.
 *
 * Wired as the ProseMirror `handleKeyDown` DIRECT view prop (via
 * `editorViewOptionsCtx` in MilkdownEditor.svelte) rather than a keymap
 * plugin, for the same reason `handlePaste` is: direct props are consulted
 * before every plugin keymap, so this wins deterministically over the preset's
 * own Enter/Tab bindings without depending on plugin registration order.
 * Everything it does not explicitly claim falls through untouched —
 * Shift-Enter hard breaks, Mod-Enter's `exitTable`, Tab/Shift-Tab cell
 * navigation, and the list-split Enter for plain and unchecked items.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { splitListItem } from '@milkdown/kit/prose/schema-list';
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
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { enclosingListItem } from './caretContext';

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

/**
 * Enter in a CHECKED task item: split with the new item unchecked. An
 * unchecked or non-task item declines — the default split already clones
 * `checked: false` / `null` correctly.
 */
export const splitCheckedTaskItem: Command = (state, dispatch) => {
  const item = enclosingListItem(state.selection);
  if (!item || item.node.attrs.checked !== true) return false;
  return splitListItem(item.node.type, { ...item.node.attrs, checked: false })(state, dispatch);
};

/**
 * The `handleKeyDown` direct view prop. Returns true only when one of the
 * parity commands above actually handled the key.
 */
export function handleParityKeyDown(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === 'Enter' && !event.shiftKey) {
    return (
      insertTableRowBelow(view.state, view.dispatch) ||
      splitCheckedTaskItem(view.state, view.dispatch)
    );
  }
  if (event.key === 'Tab' && !event.shiftKey) {
    return appendTableRowFromLastCell(view.state, view.dispatch);
  }
  return false;
}
