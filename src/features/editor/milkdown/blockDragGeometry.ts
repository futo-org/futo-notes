/*
 * Shared drop-slot geometry for Milkdown's two block-drag gestures — the desktop
 * ⠿ gutter handle (handleBlockDrag.ts) and the native shells' long-press
 * drag (mobileBlockDnd.ts), both through the shared blockDragSession.ts — so
 * both resolve drop targets identically instead of maintaining two copies that
 * could silently disagree. The move itself is equally shared, in blockMove.ts.
 *
 * A DRAG ONLY EVER LIFTS A TOP-LEVEL BLOCK, AND ONLY LANDS IN A TOP-LEVEL GAP.
 * A press anywhere inside a list (or a blockquote, or any other container)
 * lifts the whole top-level block containing it, so the slots offered are the
 * gaps between the document's own children: just below a blockquote is NOT
 * "inside the blockquote", which is where ProseMirror's own `dropPoint()` would
 * put it, and a point between two items of a list is the gap above or below
 * the whole list.
 *
 * This used to let a list item be dragged on its own, among the items of its
 * list. The live-reflow preview (`blockDragCurtain.ts`) only previews top-level
 * blocks, so those drags fell back to the drop line and a drag flipped between
 * the two depending on what was grabbed.
 *
 * THERE IS EXACTLY ONE DROP SLOT PER BOUNDARY, and `pos` alone is its whole
 * identity. This used to carry a `corner: 'before' | 'after'` as well, which
 * made the gap between two adjacent blocks TWO targets: A's `after` and B's
 * `before` are the same document position and commit the same move, but the
 * indicator drew on A's bottom edge or on B's top edge depending on which half
 * the finger was in, and the haptic ticked crossing between them. Two visually
 * distinct places to drop that meant one thing (MR !276). A block's OWN two
 * boundaries stay distinct, because those are genuinely different positions.
 *
 * `indicator` is measured the way prosemirror-dropcursor measures its own block
 * cursor — one line per position, midway between the bottom of the block before
 * the gap and the top of the block after it — so both drag paths put the line
 * in the same place.
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

/** Where the drop indicator line is drawn, in viewport coordinates. `top` is
 * the line's CENTRE, so a caller that draws a 3px bar offsets by half of it. */
export type DropIndicatorRect = { top: number; left: number; width: number };

export type DropTarget = {
  /** The document position a drop commits to, and the slot's WHOLE identity —
   * dedupe and haptics key on this and nothing else. */
  pos: number;
  /** The block the slot is measured from: the one BEFORE the gap when there is
   * one, else the one after. Canonical, so the same gap approached from either
   * side yields an identical target. */
  dom: HTMLElement;
  indicator: DropIndicatorRect;
};

/** The one canonical target for the gap at `pos`, whichever side the pointer
 * arrived from. Returns null when neither neighbour has rendered DOM to
 * measure. */
function slotAt(view: ProseView, pos: number): DropTarget | null {
  const at = view.state.doc.resolve(pos);

  const nodeBefore = at.nodeBefore;
  const nodeAfter = at.nodeAfter;
  const domBefore = nodeBefore ? view.nodeDOM(pos - nodeBefore.nodeSize) : null;
  const domAfter = nodeAfter ? view.nodeDOM(pos) : null;
  const before = domBefore instanceof HTMLElement ? domBefore : null;
  const after = domAfter instanceof HTMLElement ? domAfter : null;

  const dom = before ?? after;
  if (!dom) return null;
  const rect = dom.getBoundingClientRect();
  // In the gap when there are blocks on both sides; on the single neighbour's
  // outer edge at the document's first and last boundary.
  const top = before
    ? after
      ? (rect.bottom + after.getBoundingClientRect().top) / 2
      : rect.bottom
    : rect.top;
  return { pos, dom, indicator: { top, left: rect.left, width: rect.width } };
}

/** Resolves (x, y) to the nearest top-level gap: the gap itself when the point
 * is already in one, else WHICH of the enclosing top-level block's two
 * boundaries by which half of its rect `y` falls in (the same "which half of
 * the block" test dropCursor itself uses for a block-level indicator). */
export function resolveDropTarget(view: ProseView, x: number, y: number): DropTarget | null {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const doc = view.state.doc;
  // `$pos` would be the natural ProseMirror name, but Svelte reserves the `$`
  // prefix for variables in the .svelte consumer of this module.
  const at = doc.resolve(Math.max(0, Math.min(coords.pos, doc.content.size)));

  // The point is already in one of the document's gaps.
  if (at.depth === 0) return slotAt(view, at.pos);

  // Inside a top-level block — snap OUT to its own boundary, then pick WHICH of
  // its two by which edge `y` is closer to.
  const start = at.before(1);
  const dom = view.nodeDOM(start);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const mid = (rect.top + rect.bottom) / 2;
  return slotAt(view, y < mid ? start : start + at.node(1).nodeSize);
}

export type TopLevelBlock = { pos: number; node: ProseNode; dom: HTMLElement };

/** Resolves (x, y) to the TOP-LEVEL block node CONTAINING that point (as
 * opposed to `resolveDropTarget`'s before/after boundary) — used to
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
 * What scrolls the editor: the nearest scrollable ancestor of `view.dom`
 * (`.note-body` on desktop, which scrolls the title and the editor together),
 * or `view.dom` itself where that is the scroll box (the native embed), or the
 * window when nothing inside the page scrolls.
 */
export function editorScrollContainer(view: ProseView): HTMLElement | Window {
  const win = view.dom.ownerDocument.defaultView ?? window;
  for (let n: HTMLElement | null = view.dom; n; n = n.parentElement) {
    const overflowY = win.getComputedStyle(n).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
    if (n === view.dom && n.scrollHeight <= n.clientHeight) continue;
    return n;
  }
  return win;
}

/**
 * The drop boundary under a pointer at `clientY`, with the point clamped
 * inside the editor box so a finger dragged past either end still resolves to
 * the first or last block rather than to nothing.
 */
export function targetAtPointerY(view: ProseView, clientY: number): DropTarget | null {
  const rect = view.dom.getBoundingClientRect();
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
  return resolveDropTarget(view, contentColumnX(view), y);
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
 * `AUTO_SCROLL_EDGE_PX` of the visible top or bottom edge of whatever scrolls
 * the editor (`editorScrollContainer`), the scroller runs on its own
 * animation-frame loop at a speed that ramps with how deep into the zone the
 * pointer is, until the pointer leaves the zone, the scroller reaches an end,
 * or `stop()` is called.
 *
 * The zone and the `scrollTop` both belong to that container, NOT to
 * `view.dom`. On desktop the editable is a plain box as tall as the note inside
 * `.note-body`, so measuring its edges put the bottom zone below the window and
 * writing its `scrollTop` moved nothing (#270).
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
  /** Resolved once per drag (on the first `update`) and kept until `stop()`,
   * not per pointer move:
   * it walks the ancestors' computed styles. */
  let container: HTMLElement | null = null;
  let containerWin: Window | null = null;

  /** The element whose `scrollTop` moves the note — the window's scrolling
   * element when the window itself is the scroller. */
  function resolveContainer(): HTMLElement {
    if (container) return container;
    const found = editorScrollContainer(view);
    if (found instanceof HTMLElement) {
      container = found;
    } else {
      containerWin = found;
      container =
        (found.document.scrollingElement as HTMLElement | null) ?? found.document.documentElement;
    }
    return container;
  }

  /** The container's visible top and bottom, in viewport coordinates. */
  function visibleEdges(el: HTMLElement): { top: number; bottom: number } {
    if (containerWin) return { top: 0, bottom: containerWin.innerHeight };
    const top = el.getBoundingClientRect().top + el.clientTop;
    return { top, bottom: top + el.clientHeight };
  }

  /** Depth in the zone drives the ramp; `distance` may be negative when the
   * finger has travelled past the edge entirely, which is simply full speed. */
  function speedFor(distance: number): number {
    const depth = Math.min(Math.max((AUTO_SCROLL_EDGE_PX - distance) / AUTO_SCROLL_EDGE_PX, 0), 1);
    return (
      AUTO_SCROLL_MIN_SPEED_PX_S + (AUTO_SCROLL_MAX_SPEED_PX_S - AUTO_SCROLL_MIN_SPEED_PX_S) * depth
    );
  }

  /** Parks the loop while the pointer is outside the zone; the drag goes on. */
  function halt(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
    velocity = 0;
    carry = 0;
  }

  /** The drag is over: the next one re-resolves its container, since a note
   * that has grown since may now scroll a different element. */
  function stop(): void {
    halt();
    container = null;
    containerWin = null;
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
      const dom = resolveContainer();
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
      const edges = visibleEdges(resolveContainer());
      const fromTop = clientY - edges.top;
      const fromBottom = edges.bottom - clientY;
      // The NEARER edge wins, which only matters when the scroller is shorter
      // than two zones (a landscape phone with the keyboard up) and both would
      // otherwise claim the pointer.
      if (fromTop < AUTO_SCROLL_EDGE_PX && fromTop <= fromBottom) velocity = -speedFor(fromTop);
      else if (fromBottom < AUTO_SCROLL_EDGE_PX) velocity = speedFor(fromBottom);
      else {
        halt();
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
