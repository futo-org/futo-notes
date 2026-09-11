import { describe, expect, it } from 'vitest';

import { EditorState } from '@milkdown/kit/prose/state';
import { TableMap } from '@milkdown/kit/prose/tables';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { testSchema } from '../__fixtures__/schema';
import {
  canDeleteColumn,
  canDeleteRow,
  canInsertRowBefore,
  columnDeleteDisabledReason,
  deleteColumnAt,
  deleteRowAt,
  insertColumnAfter,
  insertColumnBefore,
  insertRowAfter,
  insertRowBefore,
  isHeaderRow,
  locateCell,
  rowDeleteDisabledReason,
} from './tableCommands';

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

describe('row insertion', () => {
  it('refuses to insert before the header row', () => {
    const { state, table } = stateWithTable(2, 2);
    const loc = locateCell(state, posInCell(table, 0, 0))!;
    expect(isHeaderRow(loc)).toBe(true);
    expect(canInsertRowBefore(loc)).toBe(false);

    const applied = insertRowBefore(posInCell(table, 0, 0))(state, () => {
      throw new Error('must not dispatch');
    });
    expect(applied).toBe(false);
  });

  it('insert-after the header lands a body row at index 1, not a second header', () => {
    const { state, table } = stateWithTable(1, 2);
    let next: EditorState = state;
    const applied = insertRowAfter(posInCell(table, 0, 0))(state, (tr) => {
      next = state.apply(tr);
    });
    expect(applied).toBe(true);
    const newTable = next.doc.firstChild!;
    expect(newTable.childCount).toBe(3); // header + 2 body rows
    expect(newTable.child(0).type.name).toBe('table_header_row');
    expect(newTable.child(1).type.name).toBe('table_row');
    expect(newTable.child(2).type.name).toBe('table_row');
  });

  it('insert-after a body row inserts immediately below it', () => {
    const { state, table } = stateWithTable(2, 1);
    let next: EditorState = state;
    insertRowAfter(posInCell(table, 1, 0))(state, (tr) => {
      next = state.apply(tr);
    });
    const newTable = next.doc.firstChild!;
    expect(newTable.childCount).toBe(4); // header + 3 body rows
    // The row that was at index 1 is unchanged; the new row is now at index 2.
    expect(newTable.child(1).textContent).toBe('r0c0');
    expect(newTable.child(3).textContent).toBe('r1c0');
  });

  it('insert-before a body row inserts immediately above it', () => {
    const { state, table } = stateWithTable(2, 1);
    let next: EditorState = state;
    insertRowBefore(posInCell(table, 1, 0))(state, (tr) => {
      next = state.apply(tr);
    });
    const newTable = next.doc.firstChild!;
    expect(newTable.childCount).toBe(4);
    expect(newTable.child(2).textContent).toBe('r0c0');
  });
});

describe('row deletion', () => {
  it('refuses to delete the header row', () => {
    const { state, table } = stateWithTable(2, 2);
    const loc = locateCell(state, posInCell(table, 0, 0))!;
    expect(canDeleteRow(loc)).toBe(false);
    expect(rowDeleteDisabledReason(loc)).toMatch(/header row/i);
    const applied = deleteRowAt(posInCell(table, 0, 0))(state, () => {
      throw new Error('must not dispatch');
    });
    expect(applied).toBe(false);
  });

  it('refuses to delete the last remaining body row', () => {
    const { state, table } = stateWithTable(1, 2);
    const loc = locateCell(state, posInCell(table, 1, 0))!;
    expect(canDeleteRow(loc)).toBe(false);
    expect(rowDeleteDisabledReason(loc)).toMatch(/at least one row/i);
    const applied = deleteRowAt(posInCell(table, 1, 0))(state, () => {
      throw new Error('must not dispatch');
    });
    expect(applied).toBe(false);
    // The table must be untouched, not partially edited.
    expect(state.doc.firstChild!.childCount).toBe(2);
  });

  it('deletes a body row when another one remains', () => {
    const { state, table } = stateWithTable(2, 2);
    const loc = locateCell(state, posInCell(table, 1, 0))!;
    expect(canDeleteRow(loc)).toBe(true);
    expect(rowDeleteDisabledReason(loc)).toBeNull();

    let next: EditorState = state;
    const applied = deleteRowAt(posInCell(table, 1, 0))(state, (tr) => {
      next = state.apply(tr);
    });
    expect(applied).toBe(true);
    const newTable = next.doc.firstChild!;
    expect(newTable.childCount).toBe(2); // header + 1 body row
    expect(newTable.child(1).child(0).textContent).toBe('r1c0'); // the OTHER body row survives
  });
});

describe('column insertion', () => {
  it('adds a header cell and a body cell in every row', () => {
    const { state, table } = stateWithTable(2, 2);
    let next: EditorState = state;
    insertColumnAfter(posInCell(table, 0, 0))(state, (tr) => {
      next = state.apply(tr);
    });
    const newTable = next.doc.firstChild!;
    for (let r = 0; r < newTable.childCount; r += 1) {
      expect(newTable.child(r).childCount).toBe(3);
    }
    expect(newTable.child(0).child(1).type.name).toBe('table_header');
    expect(newTable.child(1).child(1).type.name).toBe('table_cell');
  });

  it('insert-before lands the new column at the clicked index', () => {
    const { state, table } = stateWithTable(1, 2);
    let next: EditorState = state;
    insertColumnBefore(posInCell(table, 0, 1))(state, (tr) => {
      next = state.apply(tr);
    });
    const newTable = next.doc.firstChild!;
    const headerRow = newTable.child(0);
    expect(headerRow.childCount).toBe(3);
    expect(headerRow.child(0).textContent).toBe('h0');
    expect(headerRow.child(2).textContent).toBe('h1'); // the original col 1, pushed right
  });
});

describe('column deletion', () => {
  it('refuses to delete a table down to zero columns', () => {
    const { state, table } = stateWithTable(1, 1);
    const loc = locateCell(state, posInCell(table, 0, 0))!;
    expect(canDeleteColumn(loc)).toBe(false);
    expect(columnDeleteDisabledReason(loc)).toMatch(/at least one column/i);
    const applied = deleteColumnAt(posInCell(table, 0, 0))(state, () => {
      throw new Error('must not dispatch');
    });
    expect(applied).toBe(false);
  });

  it('deletes a column when another one remains, from every row', () => {
    const { state, table } = stateWithTable(1, 2);
    let next: EditorState = state;
    const applied = deleteColumnAt(posInCell(table, 0, 0))(state, (tr) => {
      next = state.apply(tr);
    });
    expect(applied).toBe(true);
    const newTable = next.doc.firstChild!;
    expect(newTable.child(0).childCount).toBe(1);
    expect(newTable.child(0).textContent).toBe('h1');
    expect(newTable.child(1).childCount).toBe(1);
    expect(newTable.child(1).textContent).toBe('r0c1');
  });
});
