import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import type { DecorationSet } from '@milkdown/kit/prose/view';

import {
  blockTagDecorations,
  createTagDecorationPlugin,
  docTagDecorations,
  scannableBlocks,
  scannableBlockText,
  TAG_DECORATION_CLASS,
  tagDecorationsKey,
} from './tagDecorations';
import { testSchema as s } from './__fixtures__/schema';

function para(...content: ProseNode[]): ProseNode {
  return s.nodes.paragraph.create(null, content);
}

function doc(...blocks: ProseNode[]): ProseNode {
  return s.nodes.doc.create(null, blocks);
}

/** Each decoration as the text it covers, so a test reads like the document. */
function covered(set: DecorationSet, node: ProseNode): string[] {
  return set
    .find()
    .map((d) => node.textBetween(d.from, d.to))
    .sort();
}

function ranges(decorations: ReturnType<typeof blockTagDecorations>): Array<[number, number]> {
  return decorations.map((d) => [d.from, d.to]);
}

describe('scannableBlockText', () => {
  it('is the block text when the block is all plain text', () => {
    expect(scannableBlockText(para(s.text('some #project work')))).toBe('some #project work');
  });

  it('blanks inline code without moving anything after it', () => {
    const block = para(
      s.text('see '),
      s.text('#nope', [s.marks.inlineCode.create()]),
      s.text(' and #yes'),
    );
    expect(scannableBlockText(block)).toBe('see       and #yes');
    expect(scannableBlockText(block)).toHaveLength(block.content.size);
  });

  it('substitutes a non-text inline node with its own size in spaces', () => {
    const block = para(s.text('a'), s.nodes.image.create(), s.text(' #tag'));
    expect(scannableBlockText(block)).toBe('a  #tag');
    expect(scannableBlockText(block)).toHaveLength(block.content.size);
  });
});

describe('blockTagDecorations', () => {
  it('covers exactly the `#tag`, in ProseMirror positions', () => {
    const block = para(s.text('a #tag b'));
    // Block starts at 0, so its first text character is position 1.
    expect(ranges(blockTagDecorations(block, 0))).toEqual([[3, 7]]);
  });

  it('marks every match with the tag class', () => {
    const found = blockTagDecorations(para(s.text('#one #two')), 0);
    expect(found).toHaveLength(2);
    // `type.attrs` is where Decoration.inline keeps the attributes it will put
    // on the rendered span. The rendered class itself is asserted against the
    // real bundle in tests/editor-embed-milkdown.spec.ts.
    const classOf = (d: (typeof found)[number]) =>
      (d.type as unknown as { attrs?: Record<string, string> }).attrs?.class;
    expect(found.map(classOf)).toEqual([TAG_DECORATION_CLASS, TAG_DECORATION_CLASS]);
  });

  it('does not decorate a `#` that is not a tag', () => {
    expect(blockTagDecorations(para(s.text('C#, issue #5, a#b')), 0)).toEqual([]);
  });

  it('does not decorate inside inline code', () => {
    const block = para(s.text('#tag', [s.marks.inlineCode.create()]));
    expect(blockTagDecorations(block, 0)).toEqual([]);
  });

  it('positions stay right after an image earlier in the block', () => {
    const block = para(s.nodes.image.create(), s.text(' #tag'));
    const [decoration] = blockTagDecorations(block, 0);
    expect(block.textBetween(decoration.from - 1, decoration.to - 1)).toBe('#tag');
  });
});

describe('docTagDecorations', () => {
  it('finds tags in every kind of textblock', () => {
    const d = doc(
      s.nodes.heading.create({ level: 1 }, s.text('#head')),
      para(s.text('body #body')),
      s.nodes.blockquote.create(null, para(s.text('#quoted'))),
      s.nodes.bullet_list.create(null, s.nodes.list_item.create(null, para(s.text('#listed')))),
    );
    expect(covered(docTagDecorations(d), d)).toEqual(['#body', '#head', '#listed', '#quoted']);
  });

  it('skips a fenced code block entirely', () => {
    const d = doc(s.nodes.code_block.create(null, s.text('#nope')), para(s.text('#yes')));
    expect(covered(docTagDecorations(d), d)).toEqual(['#yes']);
  });
});

describe('the plugin', () => {
  function stateWith(d: ProseNode) {
    return EditorState.create({ doc: d, plugins: [createTagDecorationPlugin()] });
  }

  function decorationsOf(state: EditorState): DecorationSet {
    const set = tagDecorationsKey.getState(state);
    if (!set) throw new Error('plugin state missing');
    return set;
  }

  it('decorates what is already in the document at init', () => {
    const state = stateWith(doc(para(s.text('#alpha #beta'))));
    expect(covered(decorationsOf(state), state.doc)).toEqual(['#alpha', '#beta']);
  });

  it('decorates a tag as it is completed', () => {
    let state = stateWith(doc(para(s.text('hello '))));
    expect(decorationsOf(state).find()).toEqual([]);
    state = state.apply(state.tr.insertText('#new', 7));
    expect(covered(decorationsOf(state), state.doc)).toEqual(['#new']);
  });

  it('drops the decoration when an edit stops it being a tag', () => {
    let state = stateWith(doc(para(s.text('#tag'))));
    expect(decorationsOf(state).find()).toHaveLength(1);
    // Delete the `#`.
    state = state.apply(state.tr.delete(1, 2));
    expect(decorationsOf(state).find()).toEqual([]);
  });

  it('keeps other blocks correct when one is edited', () => {
    const first = para(s.text('#one'));
    let state = stateWith(doc(first, para(s.text('#two'))));
    state = state.apply(state.tr.insertText('x', 1 + first.nodeSize + 4));
    expect(covered(decorationsOf(state), state.doc)).toEqual(['#one', '#twox']);
  });

  it('leaves decorations alone for a selection-only transaction', () => {
    const state = stateWith(doc(para(s.text('#alpha'))));
    const moved = state.apply(state.tr.setSelection(state.selection));
    expect(tagDecorationsKey.getState(moved)).toBe(tagDecorationsKey.getState(state));
  });

  it('picks up tags a whole-document replacement brings in', () => {
    let state = stateWith(doc(para(s.text('old'))));
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, para(s.text('#fresh'))));
    expect(covered(decorationsOf(state), state.doc)).toEqual(['#fresh']);
  });
});
