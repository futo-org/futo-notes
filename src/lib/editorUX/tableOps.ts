/**
 * Pure transforms on a parsed markdown table. No DOM, no CM6 — these are the primitives
 * that the interactive TableEditorWidget delegates to so tests can cover every edit path.
 *
 * Reuses ParsedTable/TableCell from the existing `tableWidget.ts` parser.
 */

import type { ParsedTable, TableCell } from '$lib/tableWidget';

export type Align = 'left' | 'center' | 'right';

function emptyCell(align: Align): TableCell {
  return { content: '', align };
}

function cloneTable(t: ParsedTable): ParsedTable {
  return {
    headers: t.headers.map((c) => ({ ...c })),
    rows: t.rows.map((r) => r.map((c) => ({ ...c }))),
    alignments: [...t.alignments],
  };
}

/**
 * Return a new table with a row inserted at `index` (0 = before first data row,
 * `rows.length` = append). Content is empty, alignment inherits from columns.
 */
export function addRow(t: ParsedTable, index: number): ParsedTable {
  const out = cloneTable(t);
  const clamped = Math.max(0, Math.min(index, out.rows.length));
  const newRow = out.alignments.map((a) => emptyCell(a));
  out.rows.splice(clamped, 0, newRow);
  return out;
}

/** Remove the row at `index`. No-op if index out of range. */
export function deleteRow(t: ParsedTable, index: number): ParsedTable {
  if (index < 0 || index >= t.rows.length) return t;
  const out = cloneTable(t);
  out.rows.splice(index, 1);
  return out;
}

/** Move row at `from` to `to`. `to` is the target index in the *current* row list. */
export function moveRow(t: ParsedTable, from: number, to: number): ParsedTable {
  if (from === to) return t;
  if (from < 0 || from >= t.rows.length) return t;
  if (to < 0 || to >= t.rows.length) return t;
  const out = cloneTable(t);
  const [row] = out.rows.splice(from, 1);
  out.rows.splice(to, 0, row);
  return out;
}

/**
 * Add a column. `index = 0` inserts before first column; `index = numCols` appends.
 * Alignment defaults to 'left'.
 */
export function addColumn(t: ParsedTable, index: number, align: Align = 'left'): ParsedTable {
  const numCols = t.headers.length;
  const clamped = Math.max(0, Math.min(index, numCols));
  const out = cloneTable(t);
  out.headers.splice(clamped, 0, emptyCell(align));
  out.alignments.splice(clamped, 0, align);
  for (const row of out.rows) {
    row.splice(clamped, 0, emptyCell(align));
  }
  return out;
}

/** Remove column at `index`. Requires at least one column to remain. */
export function deleteColumn(t: ParsedTable, index: number): ParsedTable {
  if (index < 0 || index >= t.headers.length) return t;
  if (t.headers.length <= 1) return t; // refuse to delete the last column
  const out = cloneTable(t);
  out.headers.splice(index, 1);
  out.alignments.splice(index, 1);
  for (const row of out.rows) {
    row.splice(index, 1);
  }
  return out;
}

/** Move column at `from` to `to`. Both indexes are in the current column list. */
export function moveColumn(t: ParsedTable, from: number, to: number): ParsedTable {
  if (from === to) return t;
  if (from < 0 || from >= t.headers.length) return t;
  if (to < 0 || to >= t.headers.length) return t;
  const out = cloneTable(t);
  const [h] = out.headers.splice(from, 1);
  out.headers.splice(to, 0, h);
  const [a] = out.alignments.splice(from, 1);
  out.alignments.splice(to, 0, a);
  for (const row of out.rows) {
    const [c] = row.splice(from, 1);
    row.splice(to, 0, c);
  }
  return out;
}

/** Set the alignment of a column. Propagates to the `align` field on every cell. */
export function setAlign(t: ParsedTable, colIndex: number, align: Align): ParsedTable {
  if (colIndex < 0 || colIndex >= t.alignments.length) return t;
  const out = cloneTable(t);
  out.alignments[colIndex] = align;
  if (out.headers[colIndex]) out.headers[colIndex].align = align;
  for (const row of out.rows) {
    if (row[colIndex]) row[colIndex].align = align;
  }
  return out;
}

/** Cycle: left → center → right → left. */
export function cycleAlign(current: Align): Align {
  if (current === 'left') return 'center';
  if (current === 'center') return 'right';
  return 'left';
}

/**
 * Set the content of a cell. `rowIndex === -1` targets the header row.
 * Content with pipe characters is escaped on serialization.
 */
export function setCellContent(
  t: ParsedTable,
  rowIndex: number,
  colIndex: number,
  content: string
): ParsedTable {
  const out = cloneTable(t);
  if (rowIndex === -1) {
    if (!out.headers[colIndex]) return t;
    out.headers[colIndex].content = content;
  } else {
    if (!out.rows[rowIndex] || !out.rows[rowIndex][colIndex]) return t;
    out.rows[rowIndex][colIndex].content = content;
  }
  return out;
}

function escapeCell(text: string): string {
  // Escape pipe chars so they don't terminate the cell. Newlines aren't valid in
  // markdown cells — collapse them to a space.
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function alignmentToken(a: Align): string {
  switch (a) {
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    default:
      return '---';
  }
}

/**
 * Serialize a table back to pipe-delimited markdown with a canonical shape:
 * `| h1 | h2 |\n| --- | --- |\n| a | b |`.
 */
export function serialize(t: ParsedTable): string {
  const lines: string[] = [];

  const headerLine = '| ' + t.headers.map((c) => escapeCell(c.content)).join(' | ') + ' |';
  lines.push(headerLine);

  const alignLine = '| ' + t.alignments.map(alignmentToken).join(' | ') + ' |';
  lines.push(alignLine);

  for (const row of t.rows) {
    const rowLine = '| ' + row.map((c) => escapeCell(c.content)).join(' | ') + ' |';
    lines.push(rowLine);
  }

  return lines.join('\n');
}

/** Return a copy with the same shape, useful for tests. */
export function duplicate(t: ParsedTable): ParsedTable {
  return cloneTable(t);
}

export type { ParsedTable, TableCell };
