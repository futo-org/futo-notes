/*
 * Keyboard parity with the CodeMirror editor's interactive elements
 * (docs/spec/editor.md "Interactive elements", issue #108):
 *
 * - Enter in a table cell inserts a row below the current one (so on the last
 *   row it appends) and puts the caret in the same column — the only way a
 *   phone user can add a row at all, since the native shells have no
 *   right-click context menu. The gfm preset instead bound bare Enter to
 *   `exitTable`, which dropped a stray empty paragraph after the table.
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
 * Enter in a table cell: insert a row below the current one, caret in the
 * same column of the new row. On the last row this appends.
 */
export const insertTableRowBelow: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  return addRowWithCaret(state, dispatch, rect, rect.top + 1, rect.left);
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
