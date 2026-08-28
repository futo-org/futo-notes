import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

import { changedRanges, repaintBlocks, type PositionedBlock } from './blockDecorations';
import { testSchema as s } from './__fixtures__/schema';

function para(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

/** Every top-level paragraph in `[from, to]`. */
function paragraphsIn(doc: ProseNode, from: number, to: number): PositionedBlock[] {
  const out: PositionedBlock[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) out.push({ node, pos });
    return !node.isTextblock;
  });
  return out;
}

/** One decoration covering the whole block, tagged with its text. */
function wholeBlock(node: ProseNode, pos: number): Decoration[] {
  return [
    Decoration.inline(pos + 1, pos + node.nodeSize - 1, { class: 'x' }, { text: node.textContent }),
  ];
}

function docOf(...texts: string[]): ProseNode {
  return s.nodes.doc.create(null, texts.map(para));
}

describe('changedRanges', () => {
  it('is empty for a transaction that changed nothing', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    expect(changedRanges(state.tr)).toEqual([]);
  });

  it('covers the inserted text', () => {
    const state = EditorState.create({ doc: docOf('one') });
    const tr = state.tr.insertText('XY', 2);
    const [[from, to]] = changedRanges(tr);
    expect(tr.doc.textBetween(from, to)).toBe('XY');
  });

  it('reports each step of a multi-step transaction', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('a', 2).insertText('b', 9);
    expect(changedRanges(tr)).toHaveLength(2);
  });

  it('carries an early step forward through the later ones', () => {
    // Insert at the END first, then at the START: the first step's range is
    // reported in a document that the second step has since shifted.
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('LONGER', 8).insertText('Z', 1);
    for (const [from, to] of changedRanges(tr)) {
      expect(to).toBeLessThanOrEqual(tr.doc.content.size);
      expect(tr.doc.textBetween(from, to)).toMatch(/^(LONGER|Z)$/);
    }
  });
});

describe('repaintBlocks', () => {
  const texts = Array.from({ length: 500 }, (_, i) => `block ${i}`);

  function decorationsFor(doc: ProseNode): DecorationSet {
    return DecorationSet.create(
      doc,
      paragraphsIn(doc, 0, doc.content.size).flatMap(({ node, pos }) => wholeBlock(node, pos)),
    );
  }

  it('rebuilds exactly the blocks the transaction touched', () => {
    const state = EditorState.create({ doc: docOf(...texts) });
    const target = state.doc.resolve(Math.floor(state.doc.content.size / 2)).start();
    const tr = state.tr.insertText('!', target);

    const rebuilt: string[] = [];
    repaintBlocks(
      decorationsFor(state.doc).map(tr.mapping, tr.doc),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      (node, pos) => {
        rebuilt.push(node.textContent);
        return wholeBlock(node, pos);
      },
    );

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toContain('!');
  });

  it('leaves the untouched blocks with their existing decorations', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('!', 2);
    const next = repaintBlocks(
      decorationsFor(state.doc).map(tr.mapping, tr.doc),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      wholeBlock,
    );
    expect(
      next
        .find()
        .map((d) => d.spec.text)
        .sort(),
    ).toEqual(['o!ne', 'two']);
  });

  it('never leaves a block with two sets of decorations', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('!', 2);
    const next = repaintBlocks(
      decorationsFor(state.doc).map(tr.mapping, tr.doc),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      wholeBlock,
    );
    expect(next.find()).toHaveLength(2);
  });

  it('survives a range that a later step pushed past the end of the document', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('xyz', 8).delete(0, state.doc.content.size);
    expect(() =>
      repaintBlocks(
        decorationsFor(state.doc).map(tr.mapping, tr.doc),
        tr.doc,
        changedRanges(tr),
        paragraphsIn,
        wholeBlock,
      ),
    ).not.toThrow();
  });
});
