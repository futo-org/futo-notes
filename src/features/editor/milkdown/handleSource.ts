/*
 * Which block the ⠿ handle stands for — the node a drag from it lifts.
 *
 * A drag only ever lifts a TOP-LEVEL block (docs/spec/editor.md): the handle
 * beside an item of a list, at any depth, stands for the whole list, and the
 * same goes for anything else nested inside a top-level block. The hover side
 * already resolves to top-level blocks (`topLevelBlockFilter`, the
 * `blockConfig` this editor gives @milkdown/plugin-block); this climbs to the
 * top-level ancestor of whatever `BlockProvider.active` says regardless, so the
 * drag cannot lift anything else even if the hover result ever disagrees.
 */
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import type { BlockMoveRange } from './blockMove';

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

/** @milkdown/plugin-block's `blockConfig.filterNodes`: only a top-level block
 * may be the one the handle stands for. A rejected node makes the plugin climb
 * to its parent, so the hover always ends on the top-level ancestor. `at` is
 * resolved immediately before the node. */
export function topLevelBlockFilter(at: ResolvedPos): boolean {
  return at.depth === 0;
}

/**
 * The top-level block a press on the handle for `active` lifts, or null when
 * `active` no longer describes the document (the plugin's hover result is only
 * refreshed on pointer movement, so an edit since can leave it stale).
 */
export function handleSourceFor(view: ProseView, active: ActiveHandleBlock): HandleSource | null {
  const doc = view.state.doc;
  const from = active.$pos.pos;
  if (doc.nodeAt(from) !== active.node || !active.node.isBlock) return null;

  const at = doc.resolve(from);
  const pos = at.depth === 0 ? from : at.before(1);
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  return { from: pos, to: pos + node.nodeSize, dom };
}
