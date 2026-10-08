/*
 * Which block the ⠿ handle stands for — the node a drag from it lifts.
 *
 * @milkdown/plugin-block picks the node its handle stands for by climbing out
 * of the hovered node for as long as it is the FIRST child of its parent
 * (`selectRootNodeByDom`). Hovering a list's second item therefore stops at the
 * list item, but hovering its first item climbs on to the list itself: the
 * handle beside the first bullet stood for — and would have dragged — every
 * bullet. That is the upstream behaviour, and `blockConfig.filterNodes` cannot
 * undo it (the filter can only force MORE climbing). So "take the first bullet
 * and make it the last one" was impossible from the handle, while every other
 * bullet could be moved.
 *
 * The plugin's answer (`BlockProvider.active`) is therefore refined here: when
 * it is a list, the source is the item the handle is actually beside — the one
 * whose box spans the press's y.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import type { BlockMoveRange } from './blockMove';

const LIST_NODES = new Set(['bullet_list', 'ordered_list']);

/** The part of `BlockProvider.active` this reads. */
export interface ActiveHandleBlock {
  node: ProseNode;
  /** Resolved at the position immediately BEFORE `node`. */
  $pos: { pos: number };
  el: HTMLElement;
}

export interface HandleSource extends BlockMoveRange {
  dom: HTMLElement;
}

/** Position of the child of the list at `listPos` whose rendered box spans `y`,
 * falling back to the first child — the handle sits at the list's top edge,
 * which is the first item's. */
function itemAt(view: ProseView, list: ProseNode, listPos: number, y: number): number {
  let pos = listPos + 1;
  let first: number | null = null;
  for (let index = 0; index < list.childCount; index += 1) {
    const child = list.child(index);
    first ??= pos;
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return pos;
    }
    pos += child.nodeSize;
  }
  return first ?? listPos + 1;
}

/**
 * The node a press at `y` on the handle for `active` would lift, or null when
 * `active` no longer describes the document (the plugin's hover result is only
 * refreshed on pointer movement, so an edit since can leave it stale).
 */
export function handleSourceFor(
  view: ProseView,
  active: ActiveHandleBlock,
  y: number,
): HandleSource | null {
  const doc = view.state.doc;
  const from = active.$pos.pos;
  if (doc.nodeAt(from) !== active.node || !active.node.isBlock) return null;

  let pos = from;
  let node = active.node;
  if (LIST_NODES.has(node.type.name)) {
    pos = itemAt(view, node, from, y);
    const item = doc.nodeAt(pos);
    if (!item) return null;
    node = item;
  }
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  return { from: pos, to: pos + node.nodeSize, dom };
}
