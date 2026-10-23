import { describe, expect, it } from 'vitest';

import { Fragment, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { tableNodeTypes } from '@milkdown/kit/prose/tables';
import { isUnwrittenFillerRow } from '@futo-notes/editor/milkdown-compat';

import { testSchema } from '../__fixtures__/schema';
import { fillCelllessRows, repairPastedTable } from './tablePaste';

const types = tableNodeTypes(testSchema);
const p = (text: string) => testSchema.node('paragraph', null, text ? [testSchema.text(text)] : []);
const header = (text: string) => types.header_cell.create(null, p(text));
const cell = (text: string) => types.cell.create(null, p(text));
const table = (...rows: ProseNode[]) => testSchema.node('table', null, rows);
const headerRow = (...cells: ProseNode[]) => testSchema.node('table_header_row', null, cells);
const row = (...cells: ProseNode[]) => testSchema.node('table_row', null, cells);

/** A state with the caret in the first cell of body row `bodyRow` (0 = the header row). */
function caretIn(rowIndex: number): EditorState {
  const doc = testSchema.node('doc', null, [
    table(headerRow(header('a'), header('b')), row(cell('c'), cell('d'))),
  ]);
  let pos = -1;
  let seen = 0;
  doc.descendants((node, at) => {
    if (node.type.name === 'paragraph' && pos < 0) {
      if (seen === rowIndex * 2) pos = at + 1;
      seen++;
    }
    return true;
  });
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));
}

const rowsOf = (slice: Slice) =>
  slice.content.content.map((r) => r.content.content.map((c) => `${c.type.name}:${c.textContent}`));

describe('repairPastedTable', () => {
  it('drops the parser-made blank header row and types the cells for a body row', () => {
    // `<table><tr><td>X</td><td>Y</td></tr></table>` parses to this.
    const pasted = new Slice(
      Fragment.from(table(headerRow(header(''), header('')), row(cell('X'), cell('Y')))),
      0,
      0,
    );
    expect(rowsOf(repairPastedTable(pasted, caretIn(1)))).toEqual([
      ['table_cell:X', 'table_cell:Y'],
    ]);
  });

  it('gives the cells the header type when they land in the header row', () => {
    const pasted = new Slice(
      Fragment.from(table(headerRow(header(''), header('')), row(cell('X'), cell('Y')))),
      0,
      0,
    );
    expect(rowsOf(repairPastedTable(pasted, caretIn(0)))).toEqual([
      ['table_header:X', 'table_header:Y'],
    ]);
  });

  it('retypes a pasted header row that lands in a body row and squares up ragged rows', () => {
    const pasted = new Slice(
      Fragment.from(table(headerRow(header('H1'), header('H2')), row(cell('v')))),
      0,
      0,
    );
    expect(rowsOf(repairPastedTable(pasted, caretIn(1)))).toEqual([
      ['table_cell:H1', 'table_cell:H2'],
      ['table_cell:v', 'table_cell:'],
    ]);
  });

  it('leaves a paste that is not a table alone', () => {
    const pasted = new Slice(Fragment.from(p('plain')), 0, 0);
    expect(repairPastedTable(pasted, caretIn(1))).toBe(pasted);
  });
});

describe('fillCelllessRows', () => {
  // `<table><thead><tr><th>x</th><th>y</th></tr></thead></table>` parses to
  // this: the schema needs a body row, and the parser gives it no cells. The gfm
  // preset's paste rule counts columns off that last row, finds none, and
  // replaced the whole table with an empty paragraph (#276).
  const headerOnly = () =>
    new Slice(Fragment.from(table(headerRow(header('x'), header('y')), row())), 0, 0);

  it('fills a cell-less body row to the table width, as the unwritten filler', () => {
    const filled = fillCelllessRows(headerOnly());
    const body = filled.content.child(0).child(1);
    expect(rowsOf(new Slice(filled.content.child(0).content, 0, 0))).toEqual([
      ['table_header:x', 'table_header:y'],
      ['table_cell:', 'table_cell:'],
    ]);
    expect(isUnwrittenFillerRow(body)).toBe(true);
  });

  it('then pastes into a cell as the header row alone', () => {
    expect(rowsOf(repairPastedTable(fillCelllessRows(headerOnly()), caretIn(1)))).toEqual([
      ['table_cell:x', 'table_cell:y'],
    ]);
  });

  it('fills a header-only table nested in another block', () => {
    const quoted = new Slice(
      Fragment.from(testSchema.node('blockquote', null, [table(headerRow(header('x')), row())])),
      0,
      0,
    );
    const inner = fillCelllessRows(quoted).content.child(0).child(0);
    expect(inner.child(1).childCount).toBe(1);
  });

  it('leaves a slice with no cell-less row alone', () => {
    const full = new Slice(Fragment.from(table(headerRow(header('a')), row(cell('b')))), 0, 0);
    expect(fillCelllessRows(full)).toBe(full);
    const plain = new Slice(Fragment.from(p('plain')), 0, 0);
    expect(fillCelllessRows(plain)).toBe(plain);
  });
});
