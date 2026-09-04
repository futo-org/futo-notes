// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorState, NodeSelection, type Transaction } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { retargetListDragToItem } from './listItemHandleDrag';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

const ITEM_HEIGHT = 30;

/** A doc of one bullet list; items stubbed as stacked boxes from y=100. */
function listView(...texts: string[]) {
  const list = s.nodes.bullet_list.create(
    null,
    texts.map((text) => s.nodes.list_item.create(null, paragraph(text))),
  );
  const doc = s.nodes.doc.create(null, [list]);
  let state = EditorState.create({ doc });
  const boxes = new Map<number, HTMLElement>();
  let pos = 1;
  let top = 100;
  list.forEach((item) => {
    const el = document.createElement('li');
    const itemTop = top;
    el.getBoundingClientRect = () => ({ top: itemTop, bottom: itemTop + ITEM_HEIGHT }) as DOMRect;
    boxes.set(pos, el);
    pos += item.nodeSize;
    top += ITEM_HEIGHT;
  });
  const dispatched: Transaction[] = [];
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: Transaction) => {
      dispatched.push(tr);
      state = state.apply(tr);
    },
    dragging: null,
    nodeDOM: (at: number) => boxes.get(at) ?? null,
  } as unknown as ProseView & { dragging: { slice: unknown; move: boolean } | null };
  /** What plugin-block does at mousedown on a first item's handle. */
  const selectList = () => view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 0)));
  return { view, dispatched, selectList, itemPos: (index: number) => [...boxes.keys()][index] };
}

function dragEvent(clientY: number) {
  const setDragImage = vi.fn();
  return {
    event: { clientY, dataTransfer: { setDragImage } } as unknown as DragEvent,
    setDragImage,
  };
}

describe('retargetListDragToItem', () => {
  it('re-selects the item beside the handle when the plugin selected the list', () => {
    const { view, dispatched, selectList, itemPos } = listView('a', 'b', 'c');
    selectList();
    const { event, setDragImage } = dragEvent(100 + ITEM_HEIGHT / 2);

    expect(retargetListDragToItem(view, event)).toBe(true);

    const selection = view.state.selection;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect((selection as NodeSelection).node.type.name).toBe('list_item');
    expect(selection.from).toBe(itemPos(0));
    // The in-flight drag now carries the item, and the ghost is the item's box.
    expect(view.dragging?.move).toBe(true);
    expect(view.dragging?.slice).toEqual((selection as NodeSelection).content());
    expect(setDragImage).toHaveBeenCalledWith(view.nodeDOM(itemPos(0)), 0, 0);
    expect(dispatched).toHaveLength(2);
  });

  it('picks the item whose box spans the drag y', () => {
    const { view, selectList, itemPos } = listView('a', 'b', 'c');
    selectList();

    retargetListDragToItem(view, dragEvent(100 + ITEM_HEIGHT * 2 + 5).event);

    expect(view.state.selection.from).toBe(itemPos(2));
  });

  it('leaves any other selection alone', () => {
    const { view, dispatched, selectList, itemPos } = listView('a', 'b');
    selectList();
    // Hovering a second item already selects the item; nothing to fix.
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, itemPos(1))));
    const before = dispatched.length;

    expect(retargetListDragToItem(view, dragEvent(105).event)).toBe(false);
    expect(dispatched).toHaveLength(before);
    expect(view.dragging).toBeNull();
  });
});
