import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

import { handleParityKeyDown } from './keyboardParity';
import { testSchema } from './__fixtures__/schema';

// What each key this module claims actually does is proven end to end by
// tests/editor-embed-milkdown-interactive.spec.ts (table Enter/Tab, checked
// task split, code-block Tab and its Escape hatch) and
// table/tableLineBreak.test.ts (Shift+Enter in a cell). This file only pins
// the keys the dispatcher must leave to the editor, which no e2e can observe.

const s = testSchema;

const p = (text: string): ProseNode =>
  text === '' ? s.nodes.paragraph.create() : s.nodes.paragraph.create(null, s.text(text));
const th = (text: string): ProseNode => s.nodes.table_header.create(null, p(text));
const td = (text: string): ProseNode => s.nodes.table_cell.create(null, p(text));
const headerRow = (...cells: ProseNode[]): ProseNode =>
  s.nodes.table_header_row.create(null, cells);
const row = (...cells: ProseNode[]): ProseNode => s.nodes.table_row.create(null, cells);
const table = (...rows: ProseNode[]): ProseNode => s.nodes.table.create(null, rows);
const doc = (...blocks: ProseNode[]): ProseNode => s.nodes.doc.create(null, blocks);

/** A 2-column table: header [a b], body rows [r1a r1b], [r2a r2b]. */
const twoRowTable = (): ProseNode =>
  table(headerRow(th('a'), th('b')), row(td('r1a'), td('r1b')), row(td('r2a'), td('r2b')));

/** A view over a state with the caret at the end of the first text node containing `text`. */
function viewWithCaretIn(
  root: ProseNode,
  text: string,
): { state: EditorState; dispatch(tr: Transaction): void } {
  let at = -1;
  root.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isText && node.text === text) at = pos + node.nodeSize;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text node "${text}" in the fixture document`);
  const initial = EditorState.create({ doc: root });
  let current = initial.apply(initial.tr.setSelection(TextSelection.create(root, at)));
  return {
    get state() {
      return current;
    },
    dispatch(tr: Transaction) {
      current = current.apply(tr);
    },
  };
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

describe('handleParityKeyDown', () => {
  it('leaves modified, composing, and unrelated keys to the editor', () => {
    const view = viewWithCaretIn(doc(twoRowTable()), 'r1a');
    // Shift+Enter in a table cell IS claimed (table/tableLineBreak.test.ts).
    expect(handleParityKeyDown(view as never, key('Enter', { metaKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { ctrlKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { altKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Enter', { isComposing: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('Tab', { shiftKey: true }))).toBe(false);
    expect(handleParityKeyDown(view as never, key('a'))).toBe(false);
  });

  it('leaves Enter in a paragraph to the editor', () => {
    const view = viewWithCaretIn(doc(p('plain')), 'plain');
    expect(handleParityKeyDown(view as never, key('Enter'))).toBe(false);
  });
});
