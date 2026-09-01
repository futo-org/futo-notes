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

/**
 * Auto-scroll engages within this many px of the scroller's top/bottom edge.
 * Comfortably wider than a fingertip's contact patch (~44px) so a finger
 * deliberately parked "at the edge" is reliably inside the zone, and still well
 * under a tenth of a phone-sized editor, so a drag through the middle of the
 * note never engages it by accident.
 */
const AUTO_SCROLL_EDGE_PX = 64;
/**
 * Speed ramp across the zone, in px/second: `MIN` at the zone's inner lip,
 * `MAX` at (or past) the very edge, linear in between so the finger's depth is
 * the throttle. MIN is about six text lines a second — slow enough to stop on
 * the boundary you meant; MAX is about a phone viewport every half second, so
 * the 250-block note (~7500px) that found this bug traverses end to end in
 * roughly six seconds of holding, against the 20-25s the QA pass spent holding.
 */
const AUTO_SCROLL_MIN_SPEED_PX_S = 200;
const AUTO_SCROLL_MAX_SPEED_PX_S = 1400;
/**
 * Longest frame gap that may be integrated in one step. A hitch, a backgrounded
 * WebView, or a GC pause would otherwise arrive as one enormous delta and
 * teleport the note; capping it means a stall costs scroll distance, never
 * position.
 */
const AUTO_SCROLL_MAX_FRAME_S = 0.05;

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

export interface DragAutoScroller {
  /** Feed the pointer's current y on every move. Starts the loop, re-aims it,
   * or stops it, depending on where the pointer now is. */
  update(clientY: number): void;
  /** Ends the loop. Idempotent. */
  stop(): void;
}

/**
 * Continuous edge auto-scroll for a block drag. While the pointer sits within
 * `AUTO_SCROLL_EDGE_PX` of `view.dom`'s top or bottom edge, the scroller runs on
 * its own animation-frame loop at a speed that ramps with how deep into the zone
 * the pointer is, until the pointer leaves the zone, the scroller reaches an
 * end, or `stop()` is called. `.ProseMirror` (view.dom) owns overflow-y here.
 *
 * IT HAS TO BE A LOOP, NOT A PER-EVENT NUDGE. This used to be one 14px step per
 * `pointermove` ("rudimentary on purpose", it said), which meant a STATIONARY
 * finger held in the edge zone — the only way a finger that must stay down can
 * reach an off-screen boundary — produced no events and therefore no scrolling
 * whatsoever. A device pass on a 250-block note held the bottom edge for 20-25
 * seconds and the content never moved: a block could only be dropped at a
 * boundary that was already on screen when it was lifted.
 *
 * `onStep` fires after each frame that actually moved the scroller, and is how
 * the caller keeps its drop indicator on the boundary now under the pointer. The
 * finger is holding still while the document sweeps past it, so the target must
 * be RECOMPUTED, never carried over.
 *
 * `stop()` MUST be reached from every drag exit — commit, no-op release, cancel,
 * editor destroy. A loop that outlives its gesture keeps scrolling the note the
 * user is now trying to read, which is worse than the bug it fixes.
 */
export function createDragAutoScroller(view: ProseView, onStep?: () => void): DragAutoScroller {
  let frame: number | null = null;
  let lastTime: number | null = null;
  /** px/second, signed. 0 means "outside the zone", i.e. not running. */
  let velocity = 0;
  /** Sub-pixel remainder, so `MIN`-speed scrolling is not rounded away to
   * nothing on engines that quantise `scrollTop` to integers. */
  let carry = 0;

  /** Depth in the zone drives the ramp; `distance` may be negative when the
   * finger has travelled past the edge entirely, which is simply full speed. */
  function speedFor(distance: number): number {
    const depth = Math.min(Math.max((AUTO_SCROLL_EDGE_PX - distance) / AUTO_SCROLL_EDGE_PX, 0), 1);
    return (
      AUTO_SCROLL_MIN_SPEED_PX_S + (AUTO_SCROLL_MAX_SPEED_PX_S - AUTO_SCROLL_MIN_SPEED_PX_S) * depth
    );
  }

  function stop(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
    velocity = 0;
    carry = 0;
  }

  function step(time: number): void {
    frame = null;
    if (velocity === 0) return;
    // The first frame has nothing to integrate against, so it only establishes
    // the clock.
    const elapsed =
      lastTime === null ? 0 : Math.min((time - lastTime) / 1000, AUTO_SCROLL_MAX_FRAME_S);
    lastTime = time;
    if (elapsed > 0) {
      const dom = view.dom;
      const wanted = velocity * elapsed + carry;
      const whole = Math.trunc(wanted);
      carry = wanted - whole;
      const from = dom.scrollTop;
      // Clamped to the document's own ends: at either end this writes nothing
      // at all rather than fighting the scroller with a value it will reject.
      const to = Math.min(Math.max(from + whole, 0), dom.scrollHeight - dom.clientHeight);
      if (to !== from) {
        dom.scrollTop = to;
        onStep?.();
      }
    }
    // Kept alive even while clamped at an end: the finger is still in the zone,
    // and the document it is scrolling can grow or move under it.
    frame = requestAnimationFrame(step);
  }

  return {
    update(clientY: number): void {
      const rect = view.dom.getBoundingClientRect();
      const fromTop = clientY - rect.top;
      const fromBottom = rect.bottom - clientY;
      // The NEARER edge wins, which only matters when the scroller is shorter
      // than two zones (a landscape phone with the keyboard up) and both would
      // otherwise claim the pointer.
      if (fromTop < AUTO_SCROLL_EDGE_PX && fromTop <= fromBottom) velocity = -speedFor(fromTop);
      else if (fromBottom < AUTO_SCROLL_EDGE_PX) velocity = speedFor(fromBottom);
      else {
        stop();
        return;
      }
      if (frame === null) {
        lastTime = null;
        carry = 0;
        frame = requestAnimationFrame(step);
      }
    },
    stop,
  };
}
