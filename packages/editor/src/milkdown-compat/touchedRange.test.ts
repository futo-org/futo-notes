import { describe, expect, it, vi } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { nodesInTouchedRange, touchedTopLevelRange } from './touchedRange';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    list: { content: 'item+', group: 'block' },
    item: { content: 'paragraph+' },
    text: { group: 'inline' },
  },
});

const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const item = (text: string) => schema.node('item', null, [p(text)]);
const list = (...texts: string[]) => schema.node('list', null, texts.map(item));
const doc = (...blocks: ReturnType<typeof p>[]) => schema.node('doc', null, blocks);

/** Position range of top-level block `index` in `d`. */
function blockRange(d: ReturnType<typeof doc>, index: number) {
  let from = 0;
  for (let i = 0; i < index; i += 1) from += d.child(i).nodeSize;
  return { from, to: from + d.child(index).nodeSize, fromIndex: index, toIndex: index + 1 };
}

describe('touchedTopLevelRange', () => {
  it('is null when nothing changed the document', () => {
    const state = EditorState.create({ doc: doc(p('one'), list('a', 'b')) });
    const tr = state.tr.setMeta('noop', true);
    expect(touchedTopLevelRange([tr], tr.doc)).toBeNull();
    expect(touchedTopLevelRange([], state.doc)).toBeNull();
  });

  it('covers exactly the top-level block an inline edit touched', () => {
    const state = EditorState.create({ doc: doc(p('one'), list('a', 'b'), p('two')) });
    // Inside the second item's paragraph: <p>one</p>=5, <list><item><p> = +3, "a" item = +5 → item b text at 5+1+5+1+1 = 13
    const tr = state.tr.insertText('x', 14);
    expect(touchedTopLevelRange([tr], tr.doc)).toEqual(blockRange(tr.doc, 1));
  });

  it('widens to every block between the first and last edit', () => {
    const state = EditorState.create({ doc: doc(p('one'), list('a'), p('two'), p('three')) });
    const tr = state.tr.insertText('!', 4).insertText('!', state.doc.content.size - 1 + 1);
    expect(touchedTopLevelRange([tr], tr.doc)).toEqual({
      from: 0,
      to: tr.doc.content.size,
      fromIndex: 0,
      toIndex: 4,
    });
  });

  it('maps an earlier transaction through a later one', () => {
    const state = EditorState.create({ doc: doc(p('one'), list('a', 'b'), p('two')) });
    const edit = state.tr.insertText('x', 14); // the list
    const after = state.apply(edit);
    const shift = after.tr.insert(0, p('inserted')); // pushes the list right by 10
    const range = touchedTopLevelRange([edit, shift], shift.doc);
    // Both the new paragraph (block 0) and the list (now block 2) are covered.
    expect(range).toEqual({ from: 0, to: blockRange(shift.doc, 2).to, fromIndex: 0, toIndex: 3 });
  });

  it('covers the list when a whole item is deleted from it', () => {
    const state = EditorState.create({ doc: doc(p('one'), list('a', 'b', 'c'), p('two')) });
    const listPos = blockRange(state.doc, 1);
    // Delete item "b": item a is 5 wide, so b spans listPos.from + 1 + 5 .. +5
    const bFrom = listPos.from + 1 + 5;
    const tr = state.tr.delete(bFrom, bFrom + 5);
    expect(touchedTopLevelRange([tr], tr.doc)).toEqual(blockRange(tr.doc, 1));
  });

  it('indexes a touch at the very end of the document as an empty block span', () => {
    const state = EditorState.create({ doc: doc(p('one'), p('two')) });
    // A selection-only transaction touches nothing; a deletion of the last
    // block's closing content still lands inside block 1.
    const tr = state.tr.insertText('!', state.doc.content.size - 1);
    const range = touchedTopLevelRange([tr], tr.doc);
    expect(range).toEqual(blockRange(tr.doc, 1));
  });
});

describe('nodesInTouchedRange', () => {
  type Visit = [string, number, string | null, number];
  const visit =
    (visits: Visit[], stopAt?: string) =>
    (node: ProseNode, pos: number, parent: ProseNode | null, index: number) => {
      visits.push([node.type.name, pos, parent?.type.name ?? null, index]);
      return node.type.name !== stopAt;
    };

  it('visits exactly what doc.nodesBetween visits over the range, in order, with the same arguments', () => {
    const state = EditorState.create({
      doc: doc(p('zero'), list('a', 'b'), p('two'), list('c'), p('four')),
    });
    // Edit inside item "b" (block 1) and the paragraph after it (block 2, 18..23).
    const tr = state.tr.insertText('!', 14).insertText('?', 21);
    const range = touchedTopLevelRange([tr], tr.doc)!;
    expect([range.fromIndex, range.toIndex]).toEqual([1, 3]);
    const expected: Visit[] = [];
    tr.doc.nodesBetween(range.from, range.to, visit(expected));
    const actual: Visit[] = [];
    nodesInTouchedRange(tr.doc, range, visit(actual));
    expect(actual).toEqual(expected);
    expect(actual.map(([name]) => name)).toEqual([
      'list',
      'item',
      'paragraph',
      'text',
      'item',
      'paragraph',
      'text',
      'paragraph',
      'text',
    ]);
  });

  it('honours a false return by skipping that subtree, like nodesBetween', () => {
    const state = EditorState.create({ doc: doc(p('zero'), list('a', 'b'), p('two')) });
    const tr = state.tr.insertText('!', 14);
    const range = touchedTopLevelRange([tr], tr.doc)!;
    const expected: Visit[] = [];
    tr.doc.nodesBetween(range.from, range.to, visit(expected, 'item'));
    const actual: Visit[] = [];
    nodesInTouchedRange(tr.doc, range, visit(actual, 'item'));
    expect(actual).toEqual(expected);
    expect(actual.map(([name]) => name)).toEqual(['list', 'item', 'item']);
  });

  it('does not read blocks before the range to reach it', () => {
    const state = EditorState.create({ doc: doc(p('zero'), p('one'), p('two'), list('a')) });
    const tr = state.tr.insertText('!', state.doc.content.size - 3);
    const range = touchedTopLevelRange([tr], tr.doc)!;
    const child = vi.spyOn(tr.doc, 'child');
    const seen: string[] = [];
    nodesInTouchedRange(tr.doc, range, (node) => {
      seen.push(node.type.name);
    });
    expect(child.mock.calls).toEqual([[3]]);
    expect(seen).toEqual(['list', 'item', 'paragraph', 'text']);
  });
});
