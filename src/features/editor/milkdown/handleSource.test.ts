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

const ITEM_HEIGHT = 30;

/** A doc of a paragraph and one bullet list; items stubbed as stacked boxes
 * from y=100. */
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
  let top = 100;
  list.forEach((item) => {
    const el = document.createElement('li');
    const itemTop = top;
    el.getBoundingClientRect = () => ({ top: itemTop, bottom: itemTop + ITEM_HEIGHT }) as DOMRect;
    boxes.set(pos, el);
    pos += item.nodeSize;
    top += ITEM_HEIGHT;
  });
  const view = {
    state,
    nodeDOM: (at: number) => boxes.get(at) ?? null,
  } as unknown as ProseView;
  const activeList: ActiveHandleBlock = { node: list, $pos: { pos: listPos }, el: listEl };
  return {
    view,
    activeList,
    introActive: { node: intro, $pos: { pos: 0 }, el: introEl } as ActiveHandleBlock,
    itemPos: (index: number) => [...boxes.keys()].filter((k) => k > listPos)[index],
  };
}

describe('handleSourceFor', () => {
  it('stands for the block the plugin hovered when it is not a list', () => {
    const { view, introActive } = listView('a', 'b');

    const source = handleSourceFor(view, introActive, 0);

    expect(source).toEqual({ from: 0, to: introActive.node.nodeSize, dom: introActive.el });
  });

  it('narrows a hovered LIST to the item beside the handle — the first bullet is not the whole list', () => {
    const { view, activeList, itemPos } = listView('a', 'b', 'c');

    const source = handleSourceFor(view, activeList, 100 + ITEM_HEIGHT / 2);

    expect(source?.from).toBe(itemPos(0));
    expect(source?.to).toBe(itemPos(1));
    expect(source?.dom).toBe(view.nodeDOM(itemPos(0)));
  });

  it('picks the item whose box spans the press y', () => {
    const { view, activeList, itemPos } = listView('a', 'b', 'c');

    const source = handleSourceFor(view, activeList, 100 + ITEM_HEIGHT * 2 + 5);

    expect(source?.from).toBe(itemPos(2));
  });

  it('falls back to the first item when the y is in no item', () => {
    const { view, activeList, itemPos } = listView('a', 'b');

    expect(handleSourceFor(view, activeList, 5)?.from).toBe(itemPos(0));
  });

  it('refuses a hover result that no longer describes the document', () => {
    const { view, introActive } = listView('a');
    const stale: ActiveHandleBlock = { ...introActive, $pos: { pos: 3 } };

    expect(handleSourceFor(view, stale, 0)).toBeNull();
  });
});
