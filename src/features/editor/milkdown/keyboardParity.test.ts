import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

import {
  appendTableRowFromLastCell,
  handleParityKeyDown,
  insertTableRowBelow,
  splitCheckedTaskItem,
} from './keyboardParity';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

const p = (text: string): ProseNode =>
  text === '' ? s.nodes.paragraph.create() : s.nodes.paragraph.create(null, s.text(text));
const th = (text: string): ProseNode => s.nodes.table_header.create(null, p(text));
const td = (text: string): ProseNode => s.nodes.table_cell.create(null, p(text));
const headerRow = (...cells: ProseNode[]): ProseNode =>
  s.nodes.table_header_row.create(null, cells);
const row = (...cells: ProseNode[]): ProseNode => s.nodes.table_row.create(null, cells);
const table = (...rows: ProseNode[]): ProseNode => s.nodes.table.create(null, rows);
const item = (text: string, checked: boolean | null = null): ProseNode =>
  s.nodes.list_item.create({ checked }, p(text));
const bullets = (...items: ProseNode[]): ProseNode => s.nodes.bullet_list.create(null, items);
const doc = (...blocks: ProseNode[]): ProseNode => s.nodes.doc.create(null, blocks);

/** A 2-column table: header [a b], body rows [r1a r1b], [r2a r2b]. */
const twoRowTable = (): ProseNode =>
  table(headerRow(th('a'), th('b')), row(td('r1a'), td('r1b')), row(td('r2a'), td('r2b')));

/** State with the caret at the end of the first text node containing `text`. */
function stateWithCaretIn(root: ProseNode, text: string): EditorState {
  let at = -1;
  root.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isText && node.text === text) at = pos + node.nodeSize;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text node "${text}" in the fixture document`);
  const state = EditorState.create({ doc: root });
  return state.apply(state.tr.setSelection(TextSelection.create(root, at)));
}

function apply(
  state: EditorState,
  command: (s: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
): { handled: boolean; state: EditorState } {
  let next = state;
  const handled = command(state, (tr: Transaction) => {
    next = state.apply(tr);
  });
  return { handled, state: next };
}

/** [rowKind, cellTexts[]] per row — the shape assertions read. */
function tableShape(root: ProseNode): Array<[string, string[]]> {
  const tbl = root.child(0);
  const rows: Array<[string, string[]]> = [];
  tbl.forEach((r) => {
    const cells: string[] = [];
    r.forEach((cell) => cells.push(cell.textContent));
    rows.push([r.type.name, cells]);
  });
  return rows;
}

/** The text of the block the selection sits in, plus its cell column if any. */
function caretCell(state: EditorState): { row: number; col: number } {
  const at = state.selection.$from;
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'table_row' || node.type.name === 'table_header_row') {
      const rowNode = node;
      const tbl = at.node(depth - 1);
      let rowIndex = -1;
      tbl.forEach((r, _offset, i) => {
        if (r === rowNode) rowIndex = i;
      });
      const cell = at.node(depth + 1);
      let colIndex = -1;
      rowNode.forEach((c, _offset, i) => {
        if (c === cell) colIndex = i;
      });
      return { row: rowIndex, col: colIndex };
    }
  }
  throw new Error('caret is not inside a table');
}

describe('insertTableRowBelow', () => {
  it('inserts an empty row below the current one, caret in the same column', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'r1b');
    const { handled, state } = apply(start, insertTableRowBelow);
    expect(handled).toBe(true);
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a', 'b']],
      ['table_row', ['r1a', 'r1b']],
      ['table_row', ['', '']],
      ['table_row', ['r2a', 'r2b']],
    ]);
    expect(caretCell(state)).toEqual({ row: 2, col: 1 });
  });

  it('appends when the caret is on the last row', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'r2a');
    const { state } = apply(start, insertTableRowBelow);
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a', 'b']],
      ['table_row', ['r1a', 'r1b']],
      ['table_row', ['r2a', 'r2b']],
      ['table_row', ['', '']],
    ]);
    expect(caretCell(state)).toEqual({ row: 3, col: 0 });
  });

  it('inserts the first body row when the caret is in the header row', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'b');
    const { state } = apply(start, insertTableRowBelow);
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a', 'b']],
      ['table_row', ['', '']],
      ['table_row', ['r1a', 'r1b']],
      ['table_row', ['r2a', 'r2b']],
    ]);
    expect(caretCell(state)).toEqual({ row: 1, col: 1 });
  });

  it('does nothing outside a table', () => {
    const start = stateWithCaretIn(doc(p('plain')), 'plain');
    expect(apply(start, insertTableRowBelow).handled).toBe(false);
  });
});

describe('appendTableRowFromLastCell', () => {
  it('appends a row and puts the caret in its first cell', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'r2b');
    const { handled, state } = apply(start, appendTableRowFromLastCell);
    expect(handled).toBe(true);
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a', 'b']],
      ['table_row', ['r1a', 'r1b']],
      ['table_row', ['r2a', 'r2b']],
      ['table_row', ['', '']],
    ]);
    expect(caretCell(state)).toEqual({ row: 3, col: 0 });
  });

  it('declines anywhere but the last cell, leaving Tab to the preset keymap', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'r2a');
    expect(apply(start, appendTableRowFromLastCell).handled).toBe(false);
    const header = stateWithCaretIn(doc(twoRowTable()), 'b');
    expect(apply(header, appendTableRowFromLastCell).handled).toBe(false);
  });
});

describe('splitCheckedTaskItem', () => {
  it('starts the new item unchecked when splitting a checked task', () => {
    const start = stateWithCaretIn(doc(bullets(item('done', true))), 'done');
    const { handled, state } = apply(start, splitCheckedTaskItem);
    expect(handled).toBe(true);
    const list = state.doc.child(0);
    expect(list.childCount).toBe(2);
    expect(list.child(0).attrs.checked).toBe(true);
    expect(list.child(1).attrs.checked).toBe(false);
  });

  it('declines an unchecked task — the default split already clones unchecked', () => {
    const start = stateWithCaretIn(doc(bullets(item('todo', false))), 'todo');
    expect(apply(start, splitCheckedTaskItem).handled).toBe(false);
  });

  it('declines a plain bullet item', () => {
    const start = stateWithCaretIn(doc(bullets(item('note', null))), 'note');
    expect(apply(start, splitCheckedTaskItem).handled).toBe(false);
  });
});

describe('handleParityKeyDown', () => {
  function fakeView(state: EditorState): {
    view: { state: EditorState; dispatch(tr: Transaction): void };
    current(): EditorState;
  } {
    let current = state;
    const view = {
      get state() {
        return current;
      },
      dispatch(tr: Transaction) {
        current = current.apply(tr);
      },
    };
    return { view, current: () => current };
  }

  const key = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({
      key,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      ...mods,
    }) as KeyboardEvent;

  it('claims Enter inside a table and inserts the row', () => {
    const { view, current } = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r1a'));
    expect(handleParityKeyDown(view as never, key('Enter'))).toBe(true);
    expect(tableShape(current().doc)).toHaveLength(4);
  });

  it('claims Tab only at the last cell', () => {
    const last = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r2b'));
    expect(handleParityKeyDown(last.view as never, key('Tab'))).toBe(true);
    const middle = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r1a'));
    expect(handleParityKeyDown(middle.view as never, key('Tab'))).toBe(false);
  });

  it('claims Enter in a checked task item', () => {
    const { view, current } = fakeView(stateWithCaretIn(doc(bullets(item('done', true))), 'done'));
    expect(handleParityKeyDown(view as never, key('Enter'))).toBe(true);
    expect(current().doc.child(0).child(1).attrs.checked).toBe(false);
  });

  it('leaves modified, composing, and unrelated keys to the editor', () => {
    const { view } = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r1a'));
    expect(handleParityKeyDown(view as never, key('Enter', { shiftKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { metaKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { ctrlKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { altKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { isComposing: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Tab', { shiftKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('a'))).toBe(false);
  });

  it('leaves Enter in a paragraph to the editor', () => {
    const { view } = fakeView(stateWithCaretIn(doc(p('plain')), 'plain'));
    expect(handleParityKeyDown(view as never, key('Enter'))).toBe(false);
  });
});
