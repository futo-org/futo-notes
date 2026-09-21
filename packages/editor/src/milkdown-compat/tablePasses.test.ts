import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { CellSelection, tableNodes } from '@milkdown/kit/prose/tables';

import { scopedTableEditing, selectionTouchesTable, transactionsTouchTable } from './tablePasses';

const pm = tableNodes({ tableGroup: 'block', cellContent: 'paragraph', cellAttributes: {} });
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    table: pm.table,
    table_row: pm.table_row,
    table_cell: pm.table_cell,
    table_header: pm.table_header,
  },
});

const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const cell = (text: string) => schema.node('table_cell', null, [p(text)]);
const row = (...texts: string[]) => schema.node('table_row', null, texts.map(cell));
const table = (...rows: ReturnType<typeof row>[]) => schema.node('table', null, rows);
const doc = (...blocks: ReturnType<typeof p>[]) => schema.node('doc', null, blocks);

/** A paragraph, a 2x2 table, a paragraph — the table starts at block 1. */
function fixture() {
  const d = doc(p('before'), table(row('a', 'b'), row('c', 'd')), p('after'));
  const tablePos = d.child(0).nodeSize;
  return { state: EditorState.create({ doc: d }), tablePos };
}

describe('transactionsTouchTable', () => {
  it('is false for an edit in a paragraph, even with a table elsewhere in the note', () => {
    const { state } = fixture();
    const tr = state.tr.insertText('x', 3);
    expect(transactionsTouchTable([tr], state.apply(tr))).toBe(false);
  });

  it('is true for an edit inside a cell', () => {
    const { state, tablePos } = fixture();
    // <table><row><cell><p> = tablePos + 3, text starts one more in.
    const tr = state.tr.insertText('x', tablePos + 4);
    expect(transactionsTouchTable([tr], state.apply(tr))).toBe(true);
  });

  it('is true when the edit inserts a table', () => {
    const state = EditorState.create({ doc: doc(p('only')) });
    const tr = state.tr.insert(state.doc.content.size, table(row('a')));
    expect(transactionsTouchTable([tr], state.apply(tr))).toBe(true);
  });

  it('is true for a selection-only transaction that lands on a cell', () => {
    // This is the transaction normalizeSelection exists for: a NodeSelection
    // on a cell must become a CellSelection, and no document change is involved.
    const { state, tablePos } = fixture();
    const tr = state.tr.setSelection(NodeSelection.create(state.doc, tablePos + 2));
    expect(transactionsTouchTable([tr], state.apply(tr))).toBe(true);
  });

  it('is false for a selection-only transaction inside a paragraph', () => {
    const { state } = fixture();
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 2));
    expect(transactionsTouchTable([tr], state.apply(tr))).toBe(false);
  });
});

describe('selectionTouchesTable', () => {
  it('sees a caret inside a cell, a cell selection, and a selection ending in a table', () => {
    const { state, tablePos } = fixture();
    const inCell = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, tablePos + 4)),
    );
    expect(selectionTouchesTable(inCell)).toBe(true);
    const cells = state.apply(
      state.tr.setSelection(CellSelection.create(state.doc, tablePos + 2, tablePos + 2)),
    );
    expect(selectionTouchesTable(cells)).toBe(true);
    const across = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 2, tablePos + 4)),
    );
    expect(selectionTouchesTable(across)).toBe(true);
  });

  it('does not see a caret in a paragraph', () => {
    const { state } = fixture();
    expect(selectionTouchesTable(state)).toBe(false);
  });
});

describe('scopedTableEditing', () => {
  const withPlugin = (d: ReturnType<typeof doc>) =>
    EditorState.create({
      doc: d,
      plugins: [scopedTableEditing({ allowTableNodeSelection: true })],
    });

  it('keeps prosemirror-tables’ key so its state and commands still resolve', () => {
    const base = scopedTableEditing();
    expect(base.spec.key).toBeDefined();
    expect(base.spec.props?.handleKeyDown).toBeDefined();
  });

  it('still normalizes a node selection on a cell into a cell selection', () => {
    const { tablePos } = fixture();
    const state = withPlugin(fixture().state.doc);
    const next = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, tablePos + 2)));
    expect(next.selection).toBeInstanceOf(CellSelection);
  });

  it('still repairs a malformed table when an edit touches it', () => {
    // A ragged table: the second row is one cell short. fixTables pads it.
    const ragged = doc(p('before'), table(row('a', 'b'), row('c')), p('after'));
    const state = withPlugin(ragged);
    const tablePos = ragged.child(0).nodeSize;
    const next = state.apply(state.tr.insertText('x', tablePos + 4));
    expect(next.doc.child(1).child(1).childCount).toBe(2);
  });

  it('leaves the document alone for an edit that touches no table', () => {
    // The whole point: an unrelated keystroke must not pay for a table walk, so
    // a ragged table elsewhere stays as it is until something touches it.
    const ragged = doc(p('before'), table(row('a', 'b'), row('c')), p('after'));
    const state = withPlugin(ragged);
    const next = state.apply(state.tr.insertText('x', 3));
    expect(next.doc.child(1).child(1).childCount).toBe(1);
    expect(next.doc.child(0).textContent).toBe('bexfore');
  });
});
