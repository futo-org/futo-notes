/* A table's lines as the page draws them (tableRowElements.ts, desktopTables.css): each row a
 * grid row of its cells, its pipes and the delimiter row kept in the text but not drawn
 * (portable-core/tables.md: views never spell pipes or the delimiter row). The facts are the
 * engine's projection: a line's role and pipes from its block description, its table's column
 * count and alignments from the slice's table entry. */
import type {
  TableAlignment,
  TableBlockDescription,
  TableLineDescription,
} from '@futo-notes/editor/wasm-payloads';
import { utf16Within, type Line } from './lineModel';

/** A row's text between two of its pipes, or its last pipe and the line's end when the row
 *  has no closing pipe, in UTF-16 units from the line's start; `content` is where the engine
 *  says its content starts, after its leading padding. */
export interface TableCellSpan {
  start: number;
  content: number;
  end: number;
}

export type TableLine =
  | {
      role: 'header' | 'row';
      /** The table's column count: its widest row's cells. */
      columns: number;
      alignments: readonly TableAlignment[];
      /** The cells this row has, in order; a shorter row is drawn padded. */
      cells: readonly TableCellSpan[];
    }
  | { role: 'delimiter' };

const DELIMITER: TableLine = { role: 'delimiter' };

/** The table facts of `line` (its text `bytes` long), which the engine describes as `description`,
 *  in `table`; null outside a table. */
export function tableLineOf(
  line: Line,
  bytes: number,
  description: TableLineDescription | null | undefined,
  table: TableBlockDescription | undefined,
): TableLine | null {
  if (!description || !table) return null;
  if (description.role === 'Delimiter') return DELIMITER;
  const ascii = bytes === line.text.length;
  const unitAt = (byte: number): number =>
    ascii ? byte - line.byteStart : utf16Within(line.text, byte - line.byteStart);
  const pipes = description.pipes.map(unitAt);
  return {
    role: description.role === 'Header' ? 'header' : 'row',
    columns: table.columns,
    alignments: table.alignments,
    cells: description.cells.map((content, column) => ({
      start: pipes[column] + 1,
      content: unitAt(content.start),
      end: pipes[column + 1] ?? line.text.length,
    })),
  };
}

/** Whether `table`, a line's facts, holds a column count or alignments other than `entry`'s. */
function isStale(table: TableLine | null, entry: TableBlockDescription): boolean {
  if (!table || table.role === 'delimiter') return false;
  return table.columns !== entry.columns || table.alignments.join() !== entry.alignments.join();
}

/** Give every row of `tables` outside lines `restyled[0]` to `restyled[1]` (just described by
 *  the engine) its table entry's column count and alignments, which an edit in one row can
 *  change (a typed `|` that widens the widest row). Only a table's two ends need checking, as
 *  the lines described are one stretch. `lineAtByte` finds the line holding a display byte.
 *  Returns the lines restyled, or null. */
export function fitTableLines(
  lines: Line[],
  [from, to]: [number, number],
  tables: readonly TableBlockDescription[],
  lineAtByte: (byte: number) => number,
): [number, number] | null {
  let widened: [number, number] | null = null;
  for (const entry of tables) {
    const first = lineAtByte(entry.range.start);
    const last = lineAtByte(entry.range.end);
    const stale = (index: number): boolean =>
      (index < from || index >= to) && isStale(lines[index].table, entry);
    if (!stale(first) && !stale(last)) continue;
    for (let index = first; index <= last; index++) {
      const table = lines[index].table;
      if (!table || table.role === 'delimiter' || !isStale(table, entry)) continue;
      lines[index].table = { ...table, columns: entry.columns, alignments: entry.alignments };
    }
    widened = widened
      ? [Math.min(widened[0], first), Math.max(widened[1], last + 1)]
      : [first, last + 1];
  }
  return widened;
}
