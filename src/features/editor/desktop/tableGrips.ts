/* The row and column grips (TableGrips.svelte): with the pointer over a cell of a table
 * (editorTables.ts), a grip left of its row and one above its column, over the table's header.
 * They are drawn over the text, outside the note's lines, so they move no text and no caret or
 * selection reaches them; placed on the caret's frame, they follow the table's sideways scroll,
 * and the column's grip hides while its column is scrolled out of the row. */
import type { Line } from './lineModel';
import { tableHeaderIndex } from './tableLayouts';
import { tableColumnParts } from './tableRowElements';

/** Where the grips go, relative to the editor's wrapper (CSS px, their top left corners; the
 *  row's grip is centred on its row's `height`, which its hit area spans); the column's null
 *  while its column is scrolled out of the row. */
export interface TableGripsState {
  row: { left: number; top: number; height: number };
  column: { left: number; top: number } | null;
}

/** A grip's size and its gap from the row or column it is for, CSS px. */
const TABLE_GRIP_SIZE = 18;
const TABLE_GRIP_GAP = 4;

/** The grips for the cell in column `column` of line `index` (its element among `elements`,
 *  drawn from `lines`), relative to `origin`. */
export function tableGripsAt({
  elements,
  lines,
  index,
  column,
  origin,
}: {
  elements: readonly HTMLElement[];
  lines: readonly Line[];
  index: number;
  column: number;
  origin: DOMRect;
}): TableGripsState {
  const row = elements[index].getBoundingClientRect();
  const header = elements[tableHeaderIndex(lines, index)];
  const headerBox = header.getBoundingClientRect();
  const cell = tableColumnParts(header)[column];
  const box = cell?.getBoundingClientRect();
  const middle = box ? (box.left + box.right) / 2 : null;
  const shows = middle !== null && middle >= headerBox.left && middle <= headerBox.right;
  return {
    row: {
      left: Math.round(Math.max(0, row.left - origin.left - TABLE_GRIP_GAP - TABLE_GRIP_SIZE)),
      top: Math.round(row.top - origin.top),
      height: Math.round(row.height),
    },
    column: shows
      ? {
          left: Math.round(middle - origin.left - TABLE_GRIP_SIZE / 2),
          top: Math.round(headerBox.top - origin.top - TABLE_GRIP_GAP - TABLE_GRIP_SIZE),
        }
      : null,
  };
}
