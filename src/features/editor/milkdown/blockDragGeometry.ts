/*
 * Shared drop-slot geometry for Milkdown's two block-drag paths — the desktop
 * ⠿ gutter handle (blockDropIndicator.ts) and the native shells' long-press
 * drag (mobileBlockDnd.ts) — so both resolve drop targets identically instead
 * of maintaining two copies that could silently disagree. The move itself is
 * equally shared, in blockMove.ts.
 *
 * A DRAGGED NODE REORDERS AMONG ITS OWN KIND. The slots offered to a drag are
 * the gaps between children of a container that could hold the node: the
 * document itself, always, and — when the node started inside a list — any
 * list of the same type, at any depth. A top-level paragraph therefore only
 * ever sees top-level gaps (the same "snap out to the enclosing top-level
 * block" rule as before: just below a blockquote is NOT "inside the
 * blockquote", which is where ProseMirror's own `dropPoint()` would put it),
 * while a list item sees the gaps between the items of its list, the items of
 * any other list of that type, and the top-level gaps for pulling it out.
 *
 * This used to be top-level only, for both paths. That made a list item
 * undraggable from the ⠿ handle: no slot could be resolved for it, so no line
 * was drawn and the drop fell through to ProseMirror's default, which re-fit
 * the item as its own new list beside the old one — "a break in between".
 *
 * A TOP-LEVEL GAP NEXT TO A SAME-TYPE LIST JOINS THAT LIST. Two adjacent lists
 * of one type cannot be told apart in markdown (they re-parse as one list), so
 * for a list item that gap is drawn and committed as the end of the list above
 * it (or the start of the one below). That is also the gesture for "make the
 * first bullet the last one": drag it just below the list.
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

/** The node being dragged and the container it is being dragged out of — the
 * doc for a top-level block, the list for a list item. The parent decides
 * which gaps the drag may land in (module doc). */
export type DragSource = { node: ProseNode; parent: ProseNode };

/** The drag source for the node starting at `pos`, or null when nothing does. */
export function dragSourceAt(doc: ProseNode, pos: number): DragSource | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  return { node, parent: doc.resolve(pos).parent };
}

/** A parent that is not the document: the only containers a drag may land
 * inside are other nodes of this exact type. */
function containerTypeOf(source: DragSource) {
  const { parent } = source;
  return parent.type === parent.type.schema.topNodeType ? null : parent.type;
}

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
  // outer edge at the container's first and last boundary.
  const top = before
    ? after
      ? (rect.bottom + after.getBoundingClientRect().top) / 2
      : rect.bottom
    : rect.top;
  return { pos, dom, indicator: { top, left: rect.left, width: rect.width } };
}

/** A top-level gap beside a list of the dragged item's own type is that list's
 * end (or start) — see the module doc. Any other slot is returned as is. */
function joinAdjacentList(
  view: ProseView,
  slot: DropTarget,
  containerType: ReturnType<typeof containerTypeOf>,
): DropTarget | null {
  if (!containerType) return slot;
  const at = view.state.doc.resolve(slot.pos);
  if (at.depth !== 0) return slot;
  if (at.nodeBefore?.type === containerType) return slotAt(view, slot.pos - 1);
  if (at.nodeAfter?.type === containerType) return slotAt(view, slot.pos + 1);
  return slot;
}

/** Resolves (x, y) to the nearest gap `source` may land in: the innermost
 * enclosing container of its kind (module doc), then WHICH of that
 * container's child boundaries by which half of the child's rect `y` falls in
 * (the same "which half of the block" test dropCursor itself uses for a
 * block-level indicator). */
export function resolveDropTarget(
  view: ProseView,
  x: number,
  y: number,
  source: DragSource,
): DropTarget | null {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const doc = view.state.doc;
  // `$pos` would be the natural ProseMirror name, but Svelte reserves the `$`
  // prefix for variables in the .svelte consumer of this module.
  const at = doc.resolve(Math.max(0, Math.min(coords.pos, doc.content.size)));
  const containerType = containerTypeOf(source);

  for (let depth = at.depth; depth >= 0; depth -= 1) {
    const container = at.node(depth);
    if (depth !== 0 && container.type !== containerType) continue;

    // The point is already in one of this container's gaps (between/around
    // its children).
    if (depth === at.depth) {
      const slot = slotAt(view, at.pos);
      return slot && joinAdjacentList(view, slot, containerType);
    }

    // Inside one of its children — snap OUT to that child's own boundary,
    // then pick WHICH of its two by which edge `y` is closer to.
    const childStart = at.before(depth + 1);
    const child = at.node(depth + 1);
    const dom = view.nodeDOM(childStart);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    const mid = (rect.top + rect.bottom) / 2;
    const slot = slotAt(view, y < mid ? childStart : childStart + child.nodeSize);
    return slot && joinAdjacentList(view, slot, containerType);
  }
  return null;
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

/* ---- drag-image DPR correction ------------------------------------------ *
 * QA #012 (Zvonimir, Linux/Hyprland): the ⠿ handle's native HTML5 drag ghost
 * rendered at roughly 200% size on his scaled desktop. This app's Linux
 * webview is webkit2gtk (Cargo.lock), not Chromium, and GTK/Wayland's own
 * scale-factor plumbing is a well-documented sore spot for exactly this class
 * of mismatch — wry/Tauri carry several open reports of a webview's content
 * disagreeing with the compositor's scale factor on Linux (e.g.
 * tauri-apps/tauri#5600, #14590, #6224) — but no report pins the drag-image
 * path specifically, and the mechanism below is NOT independently confirmed
 * against a real scaled display: the two hard constraints on this pass (no
 * OS-level input automation, and a synthetic DOM `dragstart` never opens a
 * genuine native drag session) mean the fix is unit-tested and read-reviewed
 * only. A human on a scaled Linux box still needs to eyeball it.
 *
 * The theory `dragImageScale`/`setDprCorrectedDragImage` correct for: a native
 * drag-image snapshot taken at `devicePixelRatio` physical pixels per CSS
 * pixel, then composited back onto the screen as if 1 physical pixel were 1
 * CSS pixel — which reads as an oversized ghost in direct proportion to the
 * scale factor, and is invisible at 1x (unscaled displays), which is why a
 * single unscaled machine's testing could look right while a HiDPI one does
 * not. The counter has to be the SAME ratio, read live, not a guessed
 * constant: `1 / devicePixelRatio` is a no-op at 1x (nothing to undo), and is
 * still proportionally right at a fractional ratio (1.5x, ...) a fixed 0.5
 * would get wrong.
 */

/** Pure so the ratio math is unit-testable without a DOM or DragEvent. */
export function dragImageScale(devicePixelRatio: number): number {
  return 1 / (devicePixelRatio > 0 ? devicePixelRatio : 1);
}

/**
 * Sets `event.dataTransfer`'s drag image to `source`, counter-scaled for the
 * live `devicePixelRatio`. At 1x (`scale === 1`) this is exactly
 * `setDragImage(source, 0, 0)` — no clone, no behaviour change from before
 * this fix. At any other ratio, `source` itself is left alone (it is the
 * live block, still mounted and about to be dragged) and a detached,
 * transform-scaled CLONE is dragged instead; the browser/webview only reads
 * a drag image once, synchronously, while `dragstart` is still on the stack,
 * so the clone is removed on the next frame.
 */
export function setDprCorrectedDragImage(event: DragEvent, source: HTMLElement): void {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  const scale = dragImageScale(window.devicePixelRatio);
  if (scale === 1) {
    dataTransfer.setDragImage(source, 0, 0);
    return;
  }
  const rect = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  // Sized and positioned in CSS pixels BEFORE the counter-scale so the
  // transform (not layout) is what shrinks the oversized bitmap; parked off
  // the visible page because only `dragstart`'s synchronous read of it
  // matters, never a paint the user sees.
  clone.style.position = 'fixed';
  clone.style.top = '-10000px';
  clone.style.left = '-10000px';
  clone.style.margin = '0';
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.transform = `scale(${scale})`;
  clone.style.transformOrigin = 'top left';
  clone.style.pointerEvents = 'none';
  (source.ownerDocument.body ?? document.body).appendChild(clone);
  dataTransfer.setDragImage(clone, 0, 0);
  requestAnimationFrame(() => clone.remove());
}

/**
 * The drop boundary for `source` under a pointer at `clientY`, with the point
 * clamped inside the editor box so a finger dragged past either end still
 * resolves to the first or last block rather than to nothing.
 */
export function targetAtPointerY(
  view: ProseView,
  clientY: number,
  source: DragSource,
): DropTarget | null {
  const rect = view.dom.getBoundingClientRect();
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
  return resolveDropTarget(view, contentColumnX(view), y, source);
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
