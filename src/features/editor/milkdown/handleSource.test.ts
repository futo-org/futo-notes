// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { handleSourceFor, type ActiveHandleBlock } from './handleSource';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

/** A doc of a paragraph and one bullet list, every node with a stub element. */
function listView(...texts: string[]) {
  const list = s.nodes.bullet_list.create(
    null,
    texts.map((text) => s.nodes.list_item.create(null, paragraph(text))),
  );
  const intro = paragraph('intro');
  const doc = s.nodes.doc.create(null, [intro, list]);
  const state = EditorState.create({ doc });
  const listPos = intro.nodeSize;
  const boxes = new Map<number, HTMLElement>();
  const introEl = document.createElement('p');
  boxes.set(0, introEl);
  const listEl = document.createElement('ul');
  boxes.set(listPos, listEl);
  let pos = listPos + 1;
  list.forEach((item) => {
    boxes.set(pos, document.createElement('li'));
    pos += item.nodeSize;
  });
  const view = {
    state,
    nodeDOM: (at: number) => boxes.get(at) ?? null,
  } as unknown as ProseView;
  const itemPos = (index: number) => [...boxes.keys()].filter((k) => k > listPos)[index];
  return {
    view,
    list,
    listPos,
    listEl,
    introActive: { node: intro, $pos: { pos: 0 }, el: introEl } as ActiveHandleBlock,
    activeList: { node: list, $pos: { pos: listPos }, el: listEl } as ActiveHandleBlock,
    activeItem: (index: number): ActiveHandleBlock => ({
      node: list.child(index),
      $pos: { pos: itemPos(index) },
      el: boxes.get(itemPos(index))!,
    }),
  };
}

describe('handleSourceFor', () => {
  it('stands for the block the plugin hovered when it is top-level', () => {
    const { view, introActive } = listView('a', 'b');

    const source = handleSourceFor(view, introActive);

    expect(source).toEqual({ from: 0, to: introActive.node.nodeSize, dom: introActive.el });
  });

  it('stands for the whole list when the plugin hovered the list', () => {
    const { view, activeList, list, listPos, listEl } = listView('a', 'b', 'c');

    const source = handleSourceFor(view, activeList);

    expect(source).toEqual({ from: listPos, to: listPos + list.nodeSize, dom: listEl });
  });

  // A drag only ever lifts a TOP-LEVEL block: the hovered item, at any
  // position in its list, stands for the list.
  it.each([0, 1, 2])('stands for the whole list when the plugin hovered item %i', (index) => {
    const { view, activeItem, list, listPos, listEl } = listView('a', 'b', 'c');

    const source = handleSourceFor(view, activeItem(index));

    expect(source).toEqual({ from: listPos, to: listPos + list.nodeSize, dom: listEl });
  });

  it('refuses a hover result that no longer describes the document', () => {
    const { view, introActive } = listView('a');
    const stale: ActiveHandleBlock = { ...introActive, $pos: { pos: 3 } };

    expect(handleSourceFor(view, stale)).toBeNull();
  });
});
