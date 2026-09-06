/*
 * The two table passes that walked the WHOLE document on every transaction,
 * gated on the transaction actually involving a table.
 *
 * The gfm preset installs `keepTableAlignPlugin` (copies each header cell's
 * alignment onto the cells below it) and `tableEditingPlugin`
 * (prosemirror-tables' `tableEditing`: `fixTables` repairs malformed tables
 * and `normalizeSelection` turns a node selection on a cell into a
 * CellSelection). Both find their work by diffing the old and new documents —
 * `Fragment.findDiffStart/End` and `changedDescendants` — which is a walk over
 * every top-level block, ~2ms and ~1.5ms per keystroke at 10k lines on the
 * low-end Android reference phone (tests/android-editor-perf-quick.mjs
 * --profile, 2026-09-04) against a 16ms budget for the whole keystroke.
 *
 * Neither has anything to do unless a table is inside the blocks the
 * transaction touched or the selection sits in one. That test is read off the
 * step maps (touchedRange.ts) and the selection, both O(edit) rather than
 * O(document). When it says yes, the original code runs unchanged: the
 * alignment body below is Milkdown's verbatim over the touched range, and
 * `tableEditing`'s own appendTransaction is called as is.
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
 * when no table is involved. Same plugin key, state, props and behaviour
 * otherwise, so Milkdown's table commands and Crepe's table block keep working.
 */
export function scopedTableEditing(options: { allowTableNodeSelection?: boolean } = {}): Plugin {
  const base = tableEditing(options);
  const append = base.spec.appendTransaction;
  return new Plugin({
    ...base.spec,
    appendTransaction: (transactions, oldState, newState) =>
      append && transactionsTouchTable(transactions, newState)
        ? append.call(base, transactions, oldState, newState)
        : undefined,
  });
}

/** The gfm preset's `tableEditingPlugin`, scoped. */
export const scopedTableEditingPlugin = $prose(() =>
  scopedTableEditing({ allowTableNodeSelection: true }),
);

function getChildIndex(node: ProseNode, parent: ProseNode): number {
  let index = 0;
  parent.forEach((child, _offset, i) => {
    if (child === node) index = i;
  });
  return index;
}

/**
 * The gfm preset's `keepTableAlignPlugin`, over the touched blocks only. The
 * per-cell body is Milkdown's, verbatim.
 */
export const scopedKeepTableAlignPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('FUTO_SCOPED_TABLE_ALIGN'),
      appendTransaction: (transactions, oldState, state) => {
        if (oldState.doc === state.doc) return null;
        const range = touchedTopLevelRange(transactions, state.doc);
        if (!range) return null;
        let tr: Transaction | undefined;
        const check = (node: ProseNode, pos: number): void => {
          if (node.type.name !== 'table_cell') return;
          const $pos = state.doc.resolve(pos);
          const tableRow = $pos.node($pos.depth);
          const tableHeaderRow = $pos.node($pos.depth - 1).firstChild;
          if (!tableHeaderRow) return;
          const index = getChildIndex(node, tableRow);
          const headerCell = tableHeaderRow.maybeChild(index);
          if (!headerCell) return;
          const align = headerCell.attrs.alignment as string | null;
          if (align === node.attrs.alignment) return;
          if (!tr) tr = state.tr;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, alignment: align });
        };
        nodesInTouchedRange(state.doc, range, (node, pos) => {
          if (node.type.name !== 'table') return true;
          node.nodesBetween(0, node.content.size, check, pos + 1);
          return false;
        });
        return tr ?? null;
      },
    }),
);
