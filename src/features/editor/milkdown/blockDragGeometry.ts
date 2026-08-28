/*
 * Shared TOP-LEVEL block-boundary geometry for Milkdown's two block-drag
 * paths — the ⠿ gutter handle's touch/pen fallback (handleBlockDrag.ts) and
 * the iOS long-press plugin (mobileBlockDnd.ts) — so both resolve drop targets
 * identically instead of maintaining two copies that could silently disagree.
 * The move itself is equally shared, in blockMove.ts.
 *
 * ProseMirror's own `dropPoint()` snaps to the nearest SCHEMA-VALID position
 * for a dragged slice, which is often a nested child slot (e.g. just below a
 * blockquote is still "inside the blockquote" as far as schema validity
 * goes) — not the nearest top-level sibling boundary a Notion-style block
 * reorder needs. `resolveTopLevelTarget` instead walks the doc to the
 * enclosing depth-1 (top-level) node, mirroring the walk
 * @milkdown/plugin-block's own `selectRootNodeByDom` does for hover
 * detection, then picks before/after by which half of that block's rect the
 * point falls in.
 */
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

/** Same x BlockService's own hover detection uses (block-service.ts
 * `#mousemoveCallback`): the content column's horizontal center, so
 * `posAtCoords` resolves against text rather than a side gutter. */
export function contentColumnX(view: ProseView): number {
  const rect = view.dom.getBoundingClientRect();
  return rect.left + rect.width / 2;
}

export type TopLevelTarget = { pos: number; dom: HTMLElement; corner: 'before' | 'after' };

/** Resolves (x, y) to the nearest TOP-LEVEL (depth-0/1) block boundary. See
 * the module doc comment above for why this deliberately does not reuse
 * ProseMirror's own `dropPoint()`. */
export function resolveTopLevelTarget(
  view: ProseView,
  x: number,
  y: number,
): TopLevelTarget | null {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const size = view.state.doc.content.size;
  // `$pos` would be the natural ProseMirror name, but Svelte reserves the `$`
  // prefix for variables in the .svelte consumer of this module.
  const at = view.state.doc.resolve(Math.max(0, Math.min(coords.pos, size)));

  if (at.depth === 0) {
    // Already exactly a top-level gap (between/around root children).
    const before = at.nodeBefore;
    if (before) {
      const dom = view.nodeDOM(coords.pos - before.nodeSize);
      if (dom instanceof HTMLElement) return { pos: coords.pos, dom, corner: 'after' };
    }
    const after = at.nodeAfter;
    if (after) {
      const dom = view.nodeDOM(coords.pos);
      if (dom instanceof HTMLElement) return { pos: coords.pos, dom, corner: 'before' };
    }
    return null;
  }

  // Nested inside some top-level block's subtree — snap OUT to that block's
  // own boundary, then pick before/after by which edge `y` is closer to (the
  // same "which half of the block" test dropCursor itself uses for a
  // block-level indicator).
  const start = at.before(1);
  const node = view.state.doc.nodeAt(start);
  if (!node) return null;
  const dom = view.nodeDOM(start);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const mid = (rect.top + rect.bottom) / 2;
  return y < mid
    ? { pos: start, dom, corner: 'before' }
    : { pos: start + node.nodeSize, dom, corner: 'after' };
}

export type TopLevelBlock = { pos: number; node: ProseNode; dom: HTMLElement };

/** Resolves (x, y) to the TOP-LEVEL block node CONTAINING that point (as
 * opposed to `resolveTopLevelTarget`'s before/after boundary) — used to
 * decide what a press/tap is actually grabbing. Returns null when the point
 * doesn't land inside a top-level node's subtree (e.g. the empty gap past
 * the last block). */
export function topLevelBlockAt(view: ProseView, x: number, y: number): TopLevelBlock | null {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const size = view.state.doc.content.size;
  const at = view.state.doc.resolve(Math.max(0, Math.min(coords.pos, size)));
  if (at.depth === 0) return null;
  const start = at.before(1);
  const node = view.state.doc.nodeAt(start);
  if (!node) return null;
  const dom = view.nodeDOM(start);
  if (!(dom instanceof HTMLElement)) return null;
  return { pos: start, node, dom };
}

/* ---- shared drag mechanics ---------------------------------------------- *
 * Both drag paths need the same two things while a finger is down, and they
 * used to carry their own copies of both (including their own copies of these
 * constants). */

const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 14;

/**
 * The drop boundary for a pointer at `clientY`, with the point clamped inside
 * the editor box so a finger dragged past either end still resolves to the
 * first or last block rather than to nothing.
 */
export function targetAtPointerY(view: ProseView, clientY: number): TopLevelTarget | null {
  const rect = view.dom.getBoundingClientRect();
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
  return resolveTopLevelTarget(view, contentColumnX(view), y);
}

/**
 * Nudges the editor's own scroller when the finger is near an edge. Rudimentary
 * on purpose: one step per pointermove, so it only scrolls while the finger is
 * actually moving. `.ProseMirror` (view.dom) owns overflow-y here.
 */
export function autoScrollAtEdge(view: ProseView, clientY: number): void {
  const rect = view.dom.getBoundingClientRect();
  if (clientY - rect.top < AUTO_SCROLL_EDGE_PX) {
    view.dom.scrollTop = Math.max(0, view.dom.scrollTop - AUTO_SCROLL_STEP_PX);
  } else if (rect.bottom - clientY < AUTO_SCROLL_EDGE_PX) {
    view.dom.scrollTop += AUTO_SCROLL_STEP_PX;
  }
}
