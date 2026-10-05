import { describe, expect, it } from 'vitest';

import { Fragment, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { tableNodeTypes } from '@milkdown/kit/prose/tables';

import { testSchema } from '../__fixtures__/schema';
import { repairPastedTable } from './tablePaste';

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
