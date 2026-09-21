/*
 * The ⠿ handle on a list's FIRST item drags that item, not the whole list.
 *
 * @milkdown/plugin-block picks the node its handle stands for by climbing out
 * of the hovered node for as long as it is the FIRST child of its parent
 * (`selectRootNodeByDom`). Hovering a list's second item therefore stops at the
 * list item, but hovering its first item climbs on to the list itself: the
 * handle beside the first bullet selected — and dragged — every bullet. That
 * is the upstream behaviour, and `blockConfig.filterNodes` cannot undo it (the
 * filter can only force MORE climbing). So "take the first bullet and make it
 * the last one" was impossible from the handle, while every other bullet could
 * be moved.
 *
 * This listens for the handle's `dragstart` AFTER the plugin's own handler has
 * run (registration order on one element), and when the plugin selected a list,
 * re-selects the item the handle is actually beside — the one whose box spans
 * the drag's y — and rewrites the in-flight drag (`view.dragging`, the drag
 * image) to match. Nothing about the plugin's own listeners changes.
 */
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { setDprCorrectedDragImage } from './blockDragGeometry';

const LIST_NODES = new Set(['bullet_list', 'ordered_list']);

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
 * `dragstart` on the ⠿ handle element. Returns true when the drag was
 * re-targeted from a list to one of its items.
 */
export function retargetListDragToItem(view: ProseView, event: DragEvent): boolean {
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection)) return false;
  if (!LIST_NODES.has(selection.node.type.name)) return false;

  const itemPos = itemAt(view, selection.node, selection.from, event.clientY);
  const item = NodeSelection.create(view.state.doc, itemPos);
  view.dispatch(view.state.tr.setSelection(item));
  // `node` is what prosemirror-view's own default drop reads to delete the
  // source; the public type omits it, the plugin sets it, so mirror the plugin.
  view.dragging = { slice: item.content(), move: true, node: item } as typeof view.dragging;
  const dom = view.nodeDOM(itemPos);
  // DPR-corrected (blockDragGeometry.ts, QA #012) rather than a raw
  // `setDragImage`: at 1x (no scaling bug to counter) this is that same call.
  if (dom instanceof HTMLElement) setDprCorrectedDragImage(event, dom);
  return true;
}
