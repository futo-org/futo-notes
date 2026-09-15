import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

import {
  appendTableRowFromLastCell,
  handleParityKeyDown,
  indentCodeBlockOnTab,
  insertLineBreakInTableCell,
  insertTableRowBelow,
  outdentCodeBlockOnShiftTab,
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
const code = (text: string): ProseNode => s.nodes.code_block.create(null, s.text(text));

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

// QA lane 7, 2026-09: Enter used to insert a row below EVERY cell, no matter
// which row the caret was in ("Enter will create new row" — the reported
// bug). It now only ever creates a row from the last one; everywhere else it
// just moves the caret down.
describe('insertTableRowBelow', () => {
  it('moves the caret down to the same column, inserting nothing, from a non-last body row', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'r1b');
    const { handled, state } = apply(start, insertTableRowBelow);
    expect(handled).toBe(true);
    // Unchanged: no new row, no new cell content anywhere.
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a', 'b']],
      ['table_row', ['r1a', 'r1b']],
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

  it('moves the caret into the first body row, inserting nothing, from the header row', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'b');
    const { handled, state } = apply(start, insertTableRowBelow);
    expect(handled).toBe(true);
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a', 'b']],
      ['table_row', ['r1a', 'r1b']],
      ['table_row', ['r2a', 'r2b']],
    ]);
    expect(caretCell(state)).toEqual({ row: 1, col: 1 });
  });

  it('appends from the header row when the table has exactly one row total', () => {
    // A degenerate-but-schema-valid table: header + exactly one body row, so
    // the header (row 0) and the sole body row (row 1, the last row) are
    // adjacent with nothing past the body row — Enter from the header still
    // just moves down (covered above); this is Enter from that ONE body row,
    // which is simultaneously "not the header" and "the last row".
    const oneRow = table(headerRow(th('a')), row(td('r1a')));
    const start = stateWithCaretIn(doc(oneRow), 'r1a');
    const { state } = apply(start, insertTableRowBelow);
    expect(tableShape(state.doc)).toEqual([
      ['table_header_row', ['a']],
      ['table_row', ['r1a']],
      ['table_row', ['']],
    ]);
    expect(caretCell(state)).toEqual({ row: 2, col: 0 });
  });

  it('does nothing outside a table', () => {
    const start = stateWithCaretIn(doc(p('plain')), 'plain');
    expect(apply(start, insertTableRowBelow).handled).toBe(false);
  });
});

/** The child type names of the paragraph inside the cell at (row, col). */
function cellParaKinds(root: ProseNode, row: number, col: number): string[] {
  const kinds: string[] = [];
  root
    .child(0)
    .child(row)
    .child(col)
    .child(0)
    .forEach((n) => kinds.push(n.type.name));
  return kinds;
}

// Shift+Enter in a table cell used to be a silent no-op: the preset's own
// hardbreak command sets a "hardbreak" transaction meta, and the preset's
// own hardbreakFilterPlugin rejects any transaction carrying that meta inside
// a table — so the keystroke vanished with NO document change at all, and the
// very next character landed right where the caret already was ("r1a",
// Shift+Enter, "second" saved as "r1asecond", fusing the two halves with no
// separator whatsoever). See this command's own doc in keyboardParity.ts.
describe('insertLineBreakInTableCell (Shift+Enter in a table cell)', () => {
  it('inserts a real hardbreak node after the caret, not a no-op', () => {
    const start = stateWithCaretIn(doc(twoRowTable()), 'r1a');
    const { handled, state } = apply(start, insertLineBreakInTableCell);
    expect(handled).toBe(true);
    expect(cellParaKinds(state.doc, 1, 0)).toEqual(['text', 'hardbreak']);
    // The caret sits right after the break, so the very next keystroke lands
    // AFTER it rather than fusing into "r1a" the way the bug did.
    expect(state.selection.empty).toBe(true);
    expect(state.selection.$from.nodeBefore?.type.name).toBe('hardbreak');
  });

  it('does nothing outside a table — an ordinary paragraph keeps its own hardbreak handling', () => {
    const start = stateWithCaretIn(doc(p('plain')), 'plain');
    expect(apply(start, insertLineBreakInTableCell).handled).toBe(false);
  });

  it('handleParityKeyDown routes Shift+Enter to it inside a table, and leaves it alone outside one', () => {
    const key = (mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
      ({
        key: 'Enter',
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        ...mods,
      }) as KeyboardEvent;
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

    const inTable = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r1a'));
    expect(handleParityKeyDown(inTable.view as never, key())).toBe(true);
    expect(cellParaKinds(inTable.current().doc, 1, 0)).toEqual(['text', 'hardbreak']);

    const inParagraph = fakeView(stateWithCaretIn(doc(p('plain')), 'plain'));
    expect(handleParityKeyDown(inParagraph.view as never, key())).toBe(false);
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

/** A doc with one code block reading `text`, caret collapsed at `offset` within it. */
function stateInCode(text: string, offset: number): EditorState {
  const root = doc(code(text));
  const state = EditorState.create({ doc: root });
  return state.apply(state.tr.setSelection(TextSelection.create(root, 1 + offset)));
}

/** Same, but with a range selection `[from, to)` (both offsets within the code text). */
function stateInCodeRange(text: string, from: number, to: number): EditorState {
  const root = doc(code(text));
  const state = EditorState.create({ doc: root });
  return state.apply(state.tr.setSelection(TextSelection.create(root, 1 + from, 1 + to)));
}

describe('indentCodeBlockOnTab / outdentCodeBlockOnShiftTab (QA #011)', () => {
  it('inserts two spaces at a collapsed caret', () => {
    const start = stateInCode('const x = 1;', 0);
    const { handled, state } = apply(start, indentCodeBlockOnTab);
    expect(handled).toBe(true);
    expect(state.doc.child(0).textContent).toBe('  const x = 1;');
  });

  it("inserts at the caret's own column, not the line start", () => {
    const start = stateInCode('const x = 1;', 5);
    const { state } = apply(start, indentCodeBlockOnTab);
    expect(state.doc.child(0).textContent).toBe('const   x = 1;');
  });

  it('outdents from a collapsed caret at true line start, not "before the caret"', () => {
    // The caret sits BEFORE the two leading spaces (column 0) — there is
    // nothing "immediately before" it to strip, so outdent has to look at the
    // LINE's own leading whitespace instead.
    const start = stateInCode('  const x = 1;', 0);
    const { handled, state } = apply(start, outdentCodeBlockOnShiftTab);
    expect(handled).toBe(true);
    expect(state.doc.child(0).textContent).toBe('const x = 1;');
  });

  it('outdents a single leading space when there is only one', () => {
    const start = stateInCode(' x', 0);
    const { state } = apply(start, outdentCodeBlockOnShiftTab);
    expect(state.doc.child(0).textContent).toBe('x');
  });

  it('declines an outdent when the line has no leading whitespace', () => {
    const start = stateInCode('x', 0);
    expect(apply(start, outdentCodeBlockOnShiftTab).handled).toBe(false);
  });

  it("indents every line a multi-line selection touches, from each line's own start", () => {
    const start = stateInCodeRange('one\ntwo\nthree', 0, 7); // "one\ntwo" fully
    const { handled, state } = apply(start, indentCodeBlockOnTab);
    expect(handled).toBe(true);
    expect(state.doc.child(0).textContent).toBe('  one\n  two\nthree');
  });

  it('outdents every touched line by up to two spaces', () => {
    const start = stateInCodeRange('  one\n  two\n  three', 0, 11); // "  one\n  two" fully
    const { state } = apply(start, outdentCodeBlockOnShiftTab);
    expect(state.doc.child(0).textContent).toBe('one\ntwo\n  three');
  });

  it('declines outside a code block', () => {
    const start = stateWithCaretIn(doc(p('plain')), 'plain');
    expect(apply(start, indentCodeBlockOnTab).handled).toBe(false);
    expect(apply(start, outdentCodeBlockOnShiftTab).handled).toBe(false);
  });
});

describe('handleParityKeyDown — Tab in a code block, and the Escape hatch (QA #011)', () => {
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

  it('claims Tab inside a code fence and inserts two spaces', () => {
    const { view, current } = fakeView(stateInCode('code', 0));
    expect(handleParityKeyDown(view as never, key('Tab'))).toBe(true);
    expect(current().doc.child(0).textContent).toBe('  code');
  });

  it('claims Shift-Tab inside a code fence and removes leading spaces', () => {
    const { view, current } = fakeView(stateInCode('  code', 0));
    expect(handleParityKeyDown(view as never, key('Tab', { shiftKey: true }))).toBe(true);
    expect(current().doc.child(0).textContent).toBe('code');
  });

  it('Escape arms a one-shot release: the very next Tab falls through unclaimed', () => {
    const { view, current } = fakeView(stateInCode('code', 0));
    expect(handleParityKeyDown(view as never, key('Escape'))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Tab'))).toBe(false);
    expect(current().doc.child(0).textContent).toBe('code'); // untouched
  });

  it('a released Tab claim is one-shot: the Tab after it is claimed again', () => {
    const { view, current } = fakeView(stateInCode('code', 0));
    handleParityKeyDown(view as never, key('Escape'));
    handleParityKeyDown(view as never, key('Tab')); // released, unclaimed
    expect(handleParityKeyDown(view as never, key('Tab'))).toBe(true);
    expect(current().doc.child(0).textContent).toBe('  code');
  });

  it('typing any other key disarms the Escape release', () => {
    const { view, current } = fakeView(stateInCode('code', 0));
    handleParityKeyDown(view as never, key('Escape'));
    handleParityKeyDown(view as never, key('x')); // not handled by this module, but disarms
    expect(handleParityKeyDown(view as never, key('Tab'))).toBe(true);
    expect(current().doc.child(0).textContent).toBe('  code');
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

  it('claims Enter inside a table and inserts a row from the last one', () => {
    const { view, current } = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r2a'));
    expect(handleParityKeyDown(view as never, key('Enter'))).toBe(true);
    expect(tableShape(current().doc)).toHaveLength(4);
  });

  it('claims Enter inside a table and just moves the caret from a non-last row', () => {
    const { view, current } = fakeView(stateWithCaretIn(doc(twoRowTable()), 'r1a'));
    expect(handleParityKeyDown(view as never, key('Enter'))).toBe(true);
    expect(tableShape(current().doc)).toHaveLength(3); // unchanged — no row inserted
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
    // Shift+Enter in a table cell is claimed now — see the
    // "insertLineBreakInTableCell" describe block below.
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
