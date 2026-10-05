import { describe, expect, it } from 'vitest';

import { EditorState } from '@milkdown/kit/prose/state';
import { TableMap } from '@milkdown/kit/prose/tables';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { testSchema } from '../__fixtures__/schema';
import { locateCell } from './tableCommands';

/** A table with `bodyRows` body rows and `cols` columns, one paragraph of
 * text per cell so positions are unambiguous ("h0", "h1", "r1c0", ...). */
function buildTable(bodyRows: number, cols: number): ProseNode {
  const cell = (type: 'table_header' | 'table_cell', text: string) =>
    testSchema.nodes[type]!.create(
      null,
      testSchema.nodes.paragraph!.create(null, testSchema.text(text)),
    );

  const headerRow = testSchema.nodes.table_header_row!.create(
    null,
    Array.from({ length: cols }, (_, c) => cell('table_header', `h${c}`)),
  );
  const rows = Array.from({ length: bodyRows }, (_, r) =>
    testSchema.nodes.table_row!.create(
      null,
      Array.from({ length: cols }, (_, c) => cell('table_cell', `r${r}c${c}`)),
    ),
  );
  return testSchema.nodes.table!.create(null, [headerRow, ...rows]);
}

function stateWithTable(bodyRows: number, cols: number): { state: EditorState; table: ProseNode } {
  const table = buildTable(bodyRows, cols);
  const doc = testSchema.nodes.doc!.create(null, table);
  return { state: EditorState.create({ schema: testSchema, doc }), table };
}

/** A text position inside the cell at (row, col) — row 0 is the header. */
function posInCell(table: ProseNode, row: number, col: number): number {
  const map = TableMap.get(table);
  // +1: doc's opening tag. +1: table's opening tag. +2: into the cell's
  // paragraph and past its own opening tag, to sit inside the text.
  return 1 + 1 + map.positionAt(row, col, table) + 2;
}

describe('locateCell', () => {
  it('resolves a position inside a cell to its row/column', () => {
    const { state, table } = stateWithTable(2, 3);
    const loc = locateCell(state, posInCell(table, 1, 2));
    expect(loc).not.toBeNull();
    expect(loc!.top).toBe(1);
    expect(loc!.left).toBe(2);
  });

  it('returns null outside any table', () => {
    const doc = testSchema.nodes.doc!.create(
      null,
      testSchema.nodes.paragraph!.create(null, testSchema.text('hi')),
    );
    const state = EditorState.create({ schema: testSchema, doc });
    expect(locateCell(state, 1)).toBeNull();
  });
});

// Row/column insert and delete (guards included: header row immunity, last
// row/column refusal) are exercised end-to-end through the grip menu in
// tests/editor-embed-milkdown-table-grips.spec.ts, against the real commands
// this module exports — that removed the direct-invocation duplicates here.
