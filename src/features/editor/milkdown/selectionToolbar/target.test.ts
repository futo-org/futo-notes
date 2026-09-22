import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state';

import { testSchema } from '../__fixtures__/schema';
import { linkRunAt, resolveSelectionToolbar, selectionToolbarTarget } from './target';

const s = testSchema;
const p = (...content: ProseNode[]): ProseNode => s.nodes.paragraph.create(null, content);
const doc = (...blocks: ProseNode[]): ProseNode => s.nodes.doc.create(null, blocks);
const text = (value: string, marks: ProseNode['marks'] = []) => s.text(value, marks);

/** A state selecting `[from, to]` as a text selection. */
function selecting(root: ProseNode, from: number, to: number): EditorState {
  const state = EditorState.create({ doc: root });
  return state.apply(state.tr.setSelection(TextSelection.create(root, from, to)));
}

describe('resolveSelectionToolbar', () => {
  it('is a desktop surface', () => {
    expect(resolveSelectionToolbar(false)).toBe('enabled');
    expect(resolveSelectionToolbar(true)).toBe('disabled');
  });
});

describe('selectionToolbarTarget', () => {
  it('is null for a caret', () => {
    const root = doc(p(text('hello world')));
    expect(selectionToolbarTarget(selecting(root, 3, 3))).toBeNull();
  });

  it('is the selected range for a word', () => {
    const root = doc(p(text('hello world')));
    expect(selectionToolbarTarget(selecting(root, 1, 6))).toEqual({
      from: 1,
      to: 6,
      linkHref: null,
    });
  });

  it('spans blocks, so a paragraph-crossing selection can be bolded in one go', () => {
    const root = doc(p(text('one')), p(text('two')));
    // "ne" through "tw": positions inside the first and the second paragraph.
    const target = selectionToolbarTarget(selecting(root, 2, 8));
    expect(target).toEqual({ from: 2, to: 8, linkHref: null });
  });

  it('is null for whitespace only', () => {
    const root = doc(p(text('a   b')));
    expect(selectionToolbarTarget(selecting(root, 2, 5))).toBeNull();
  });

  it('is null inside a fenced code block, where nothing is markup', () => {
    const root = doc(s.nodes.code_block.create(null, text('const x = 1')));
    expect(selectionToolbarTarget(selecting(root, 1, 6))).toBeNull();
  });

  it('is null when the selection ends inside a code block', () => {
    const root = doc(p(text('prose')), s.nodes.code_block.create(null, text('code')));
    // From "rose" into the fence.
    expect(selectionToolbarTarget(selecting(root, 2, 10))).toBeNull();
  });

  it('is null for a node selection', () => {
    const root = doc(p(text('before')), s.nodes.horizontal_rule.create());
    const state = EditorState.create({ doc: root });
    const onRule = state.apply(state.tr.setSelection(NodeSelection.create(root, 8)));
    expect(selectionToolbarTarget(onRule)).toBeNull();
  });

  it('finds the whole run of a link, across the marks that split its text', () => {
    const link = s.marks.link.create({ href: 'https://example.test' });
    const strong = s.marks.strong.create();
    // "see " | "the " | "docs" (bold) | " now": the link spans two text nodes.
    const root = doc(
      p(text('see '), text('the ', [link]), text('docs', [link, strong]), text(' now')),
    );
    const run = linkRunAt(root, 7);
    expect(run).toMatchObject({ from: 5, to: 13 });
    expect(run?.mark.attrs.href).toBe('https://example.test');
    // Outside the link there is no run.
    expect(linkRunAt(root, 2)).toBeNull();
    expect(linkRunAt(root, 15)).toBeNull();
  });

  it('keeps two adjacent links apart', () => {
    const a = s.marks.link.create({ href: 'https://a.test' });
    const b = s.marks.link.create({ href: 'https://b.test' });
    const root = doc(p(text('aaa', [a]), text('bbb', [b])));
    expect(linkRunAt(root, 2)).toMatchObject({ from: 1, to: 4 });
    expect(linkRunAt(root, 5)).toMatchObject({ from: 4, to: 7 });
  });

  it('reports the href of the link the selection head sits in', () => {
    const link = s.marks.link.create({ href: 'https://example.test' });
    const root = doc(p(text('see '), text('the docs', [link]), text(' now')));
    // "the" inside the link.
    expect(selectionToolbarTarget(selecting(root, 5, 8))?.linkHref).toBe('https://example.test');
    // "see" outside it.
    expect(selectionToolbarTarget(selecting(root, 1, 4))?.linkHref).toBeNull();
  });
});
