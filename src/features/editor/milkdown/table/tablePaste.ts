/*
 * Pasting a table (a spreadsheet or web `<table>`, or cells copied out of this
 * editor) while the caret is in a table cell (RC-53).
 *
 * `prosemirror-tables`' paste handler was written for a schema where one row
 * type holds header and body cells alike. The GFM preset splits them: the
 * FIRST row is a `table_header_row` that may only hold `table_header`, every
 * other row a `table_row` that may only hold `table_cell`. Two things then go
 * wrong on the way in:
 *
 * - `<table><tr><td>..` has no `<th>`, so the parser fills the schema's
 *   mandatory header row with an EMPTY one. `pastedCells` reads that filler as
 *   a real pasted row and lands it (blank) over the target's row, or pads it with
 *   body cells, and the paste dies inside
 *   `TableMap.positionAt` with a RangeError — the paste is dropped.
 * - A pasted cell keeps the type it had in the SOURCE row, so header cells
 *   land in a body row (and body cells in the header row) and the replace
 *   cannot fit them.
 *
 * `transformPasted` runs before every `handlePaste`, so the slice is repaired
 * there: an empty filler header row is dropped and every pasted cell is given the type
 * of the row it will land in. Anything that is not a pasted table is untouched.
 *
 * The other filler goes too: a header-only table's empty body row (the schema
 * needs one, `isUnwrittenFillerRow`), which is in the editor's own copy of
 * such a table and blanked out the target row under the one the header lands on.
 *
 * A header-only table from anywhere else (`<thead>` and no `<tbody>`) parses
 * with that body row holding no cells at all, and never got this far: the gfm
 * preset's paste rule (`tablePasteRule`) counts a table's columns off its LAST
 * row, found none, and replaced the whole table with an empty paragraph —
 * pasted into a cell, that blanked the rest of its row and broke the table in
 * two (#276). `fillCelllessRows` runs ahead of that rule and fills the row the
 * way a load does.
 */
import { Fragment, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state';
import { isInTable, selectedRect, tableNodeTypes } from '@milkdown/kit/prose/tables';
import { $pasteRule, $prose } from '@milkdown/kit/utils';
import { asFillerRow, isUnwrittenFillerRow } from '@futo-notes/editor/milkdown-compat';

/** The rows of a pasted table, or null when `slice` is not a table paste. */
function pastedRows(slice: Slice): ProseNode[] | null {
  let content = slice.content;
  while (content.childCount === 1 && content.child(0).type.spec.tableRole === 'table') {
    content = content.child(0).content;
  }
  if (content.childCount === 0) return null;
  const rows: ProseNode[] = [];
  for (let i = 0; i < content.childCount; i++) {
    const row = content.child(i);
    if (row.type.spec.tableRole !== 'row') return null;
    rows.push(row);
  }
  return rows;
}

function isBlankRow(row: ProseNode): boolean {
  let blank = row.childCount > 0;
  // An empty cell is exactly one empty paragraph (2 tokens); anything more is content.
  row.forEach((cell) => {
    if (cell.content.size > 2) blank = false;
  });
  return blank;
}

/**
 * `slice` repaired for a paste whose first cell lands in `state`'s current
 * table cell. Returns `slice` itself when there is nothing to repair.
 */
export function repairPastedTable(slice: Slice, state: EditorState): Slice {
  if (!isInTable(state)) return slice;
  // A header-only table's empty filler row (the schema needs a body row) is
  // not the clipboard's: pasted, it would blank out a real row of the target.
  const rows = pastedRows(slice)?.filter((row) => !isUnwrittenFillerRow(row));
  if (!rows?.length) return slice;

  // The parser's mandatory header filler: a leading row of only empty cells,
  // in front of the real rows. A pasted table whose header row really is blank
  // loses that blank row too — nothing but empty cells, and pasting it would
  // blank out a real row of the target.
  const real = rows.length > 1 && isBlankRow(rows[0]) ? rows.slice(1) : rows;

  const types = tableNodeTypes(state.schema);
  const top = selectedRect(state).top;
  const width = Math.max(...real.map((row) => row.childCount));
  const fixed = real.map((row, i) => {
    const cellType = top + i === 0 ? types.header_cell : types.cell;
    const cells: ProseNode[] = [];
    row.forEach((cell) => {
      cells.push(
        cell.type === cellType ? cell : cellType.create(cell.attrs, cell.content, cell.marks),
      );
    });
    while (cells.length < width) cells.push(cellType.createAndFill() as ProseNode);
    return types.row.create(null, Fragment.from(cells));
  });
  return new Slice(Fragment.from(fixed), 0, 0);
}

/**
 * `slice` with every pasted table's cell-less body row filled with empty cells
 * to the table's width and marked as the unwritten filler — what a load makes
 * of a header-only table — so `repairPastedTable` drops it in a table and a
 * save does not write it outside one. Returns `slice` itself when no table in
 * it has such a row.
 */
export function fillCelllessRows(slice: Slice): Slice {
  const content = fillFragment(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

function fillFragment(fragment: Fragment): Fragment {
  let changed = false;
  const nodes: ProseNode[] = [];
  fragment.forEach((node) => {
    const filled = node.type.spec.tableRole === 'table' ? fillTable(node) : fillChildren(node);
    if (filled !== node) changed = true;
    nodes.push(filled);
  });
  return changed ? Fragment.from(nodes) : fragment;
}

function fillChildren(node: ProseNode): ProseNode {
  if (node.isLeaf) return node;
  const content = fillFragment(node.content);
  return content === node.content ? node : node.copy(content);
}

function fillTable(table: ProseNode): ProseNode {
  const cellType = tableNodeTypes(table.type.schema).cell;
  let width = 0;
  table.forEach((row) => {
    width = Math.max(width, row.childCount);
  });
  if (width === 0) return table;
  let changed = false;
  const rows: ProseNode[] = [];
  table.forEach((row) => {
    if (row.childCount > 0 || !row.type.contentMatch.matchType(cellType)) {
      rows.push(row);
      return;
    }
    const cells = Array.from({ length: width }, () => cellType.createAndFill() as ProseNode);
    rows.push(asFillerRow(row, cells));
    changed = true;
  });
  return changed ? table.copy(Fragment.from(rows)) : table;
}

/**
 * Ahead of the gfm preset's own paste rule, which runs at the default priority
 * (50) and would drop the whole table first. Paste rules run on HTML pastes
 * before any plugin's `transformPasted`.
 */
export const headerOnlyTablePaste = $pasteRule(() => ({
  priority: 100,
  run: (slice, _view, isPlainText) => (isPlainText ? slice : fillCelllessRows(slice)),
}));

/** Registered with the table plugins (`tableGrips` in `./tableGrips`). */
export const tablePasteRepair = $prose(
  () =>
    new Plugin({
      key: new PluginKey('FUTO_TABLE_PASTE_REPAIR'),
      props: {
        transformPasted: (slice, view) => repairPastedTable(slice, view.state),
      },
    }),
);
