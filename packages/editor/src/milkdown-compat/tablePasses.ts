/*
 * Scope Milkdown's table passes to touched blocks. Their whole-document diffs
 * alone cost ~3.5 ms per keystroke at 10k lines on the reference Android phone
 * (2026-09-04), out of the entire editor's 16 ms budget. Table editing still
 * delegates repairs and selection normalization to prosemirror-tables.
 */
import { $prose } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { CellSelection, tableEditing } from '@milkdown/kit/prose/tables';
import { markRowsFilledFromNothing } from './tableFillerRow';
import { nodesInTouchedRange, touchedTopLevelRange } from './touchedRange';

function isTable(node: ProseNode): boolean {
  return node.type.spec.tableRole === 'table';
}

/** Whether `pos` sits anywhere inside a table. */
function inTable($pos: { depth: number; node: (depth: number) => ProseNode }): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (isTable($pos.node(depth))) return true;
  }
  return false;
}

/** Whether the selection is in, on, or across a table. */
export function selectionTouchesTable(state: EditorState): boolean {
  const { selection } = state;
  if (selection instanceof CellSelection) return true;
  if (selection instanceof NodeSelection && selection.node.type.spec.tableRole) return true;
  return inTable(selection.$from) || inTable(selection.$to);
}

/**
 * Whether the table passes have anything to look at: a table inside a
 * top-level block the transactions touched, or a selection that involves one.
 */
export function transactionsTouchTable(
  transactions: readonly Transaction[],
  state: EditorState,
): boolean {
  if (selectionTouchesTable(state)) return true;
  const range = touchedTopLevelRange(transactions, state.doc);
  if (!range) return false;
  let found = false;
  nodesInTouchedRange(state.doc, range, (node) => {
    if (found) return false;
    if (isTable(node)) found = true;
    return !found;
  });
  return found;
}

/**
 * prosemirror-tables' `tableEditing`, with its per-transaction pass skipped
 * when no table is involved. Same plugin key, state, props and behavior
 * otherwise, so Milkdown's table commands and Crepe's table block keep working
 * — except that a row its `fixTables` fills from nothing is marked as the
 * schema's filler (`./tableFillerRow`), which the serializer does not write
 * while it is empty.
 */
export function scopedTableEditing(options: { allowTableNodeSelection?: boolean } = {}): Plugin {
  const base = tableEditing(options);
  const append = base.spec.appendTransaction;
  return new Plugin({
    ...base.spec,
    appendTransaction: (transactions, oldState, newState) => {
      if (!append || !transactionsTouchTable(transactions, newState)) return undefined;
      const tr = append.call(base, transactions, oldState, newState);
      return tr ? markRowsFilledFromNothing(tr) : tr;
    },
  });
}

/** The gfm preset's `tableEditingPlugin`, scoped. */
export const scopedTableEditingPlugin = $prose(() =>
  scopedTableEditing({ allowTableNodeSelection: true }),
);

/** Copy each header's alignment down its column, only in tables the transaction touched. */
export function scopedKeepTableAlign(): Plugin {
  return new Plugin({
    key: new PluginKey('FUTO_SCOPED_TABLE_ALIGN'),
    appendTransaction: (transactions, oldState, state) => {
      if (oldState.doc === state.doc) return null;
      const range = touchedTopLevelRange(transactions, state.doc);
      if (!range) return null;
      let tr: Transaction | undefined;
      nodesInTouchedRange(state.doc, range, (node, pos) => {
        if (node.type.name !== 'table') return true;
        const header = node.firstChild;
        if (!header) return false;
        node.nodesBetween(
          0,
          node.content.size,
          (cell, cellPos, _parent, column) => {
            if (cell.type.name !== 'table_cell') return;
            const headerCell = header.maybeChild(column);
            if (!headerCell) return;
            const alignment = headerCell.attrs.alignment as string | null;
            if (alignment === cell.attrs.alignment) return;
            tr ??= state.tr;
            tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, alignment });
          },
          pos + 1,
        );
        return false;
      });
      return tr ?? null;
    },
  });
}

export const scopedKeepTableAlignPlugin = $prose(scopedKeepTableAlign);
