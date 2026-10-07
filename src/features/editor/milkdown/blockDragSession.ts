/*
 * What a block drag looks like and does once the block is airborne — shared by
 * BOTH gestures that can lift one: the native shells' long press
 * (`mobileBlockDnd.ts`) and the desktop ⠿ handle press-and-move
 * (`handleBlockDrag.ts`). Each owns how its gesture STARTS (arming, the long
 * press timer, the movement threshold) and calls in here at lift; this owns
 * everything after: the source block dimmed in place, a ghost card drawn on the
 * page that follows the pointer by delta, the one drop indicator line at the
 * resolved gap, edge auto-scroll, and the commit through `blockMove.ts`.
 *
 * NOTHING HERE IS AN OS DRAG. The ghost is a clone of the block, drawn by the
 * page, so no platform draws its own drag image — which is the point: the
 * desktop handle used to be the browser's HTML5 drag, whose OS-drawn image came
 * out oversized on a fractionally scaled WebKitGTK display, where nothing the
 * page does can reliably fix the picture.
 *
 * The source range may be a top-level block or a list item
 * (`blockDragGeometry.ts` resolves the gaps for either).
 *
 * Gating: `blockDragSourcePlugin` is mounted for every editor (it is only the
 * state behind the dim); a session is created by whichever gesture the editor
 * got (`blockDragMode.ts`).
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  createDragAutoScroller,
  dragSourceAt,
  targetAtPointerY,
  type DragAutoScroller,
  type DropTarget,
} from './blockDragGeometry';
import { isNoOpDrop, moveBlock, type BlockMoveRange } from './blockMove';

/** What the gesture hands over at lift. */
export interface BlockDragLift extends BlockMoveRange {
  /** The block's live DOM — measured for the ghost's placement. */
  dom: HTMLElement;
  /** A clone of `dom` taken BEFORE the dim decoration renders: a clone taken
   * after would inherit the 35% opacity, and that same re-render can replace
   * the live node's DOM out from under the gesture. */
  clone: HTMLElement;
}

export interface BlockDragSessionOptions {
  /** The drop indicator moved to a DIFFERENT boundary (never for auto-scroll,
   * which is a hold). The long press turns it into its 'move' haptic. */
  onBoundaryChange?: () => void;
}

/** Horizontal breathing room the ghost card adds around the block's own rect,
 * so the preview reads as a card the block sits inside rather than a crop of
 * it. Mirrored as the card's own padding so the text stays put under the
 * finger. */
const GHOST_PAD_X_PX = 12;
/** Exported so the ghost-geometry regression test can assert the card's
 * position and content height against the block's own rect without keeping a
 * second copy of the number. */
export const GHOST_PAD_Y_PX = 10;
/** How much of the screen the card may cover before it is cropped.
 *
 * Applied in JS, from `window.innerHeight`, NOT as `max-height: 40vh` in the
 * stylesheet. Both native hosts render this bundle in a web view whose INITIAL
 * CONTAINING BLOCK is zero-height — the same defect `editor.html` pins the body
 * against, and the reason `milkdownEditor.css`'s bottom padding is written
 * `max(40vh, 280px)` — so `vh` resolves to 0 there while `window.innerHeight`
 * reports the real height. Measured on an Android 16 / Chromium 133 WebView:
 * a `40vh` probe measured 0px with `innerHeight` at 647. With
 * `overflow: hidden` above it, that collapsed the card to its own padding —
 * a 22px sliver of a 105px block, sitting above the drop indicator (MR !276).
 * `innerHeight` is the same number `createGhost` already trusts for the width
 * clamp. */
const GHOST_MAX_HEIGHT_FRACTION = 0.4;
/** How much the card grows on lift, so it reads as picked up off the page. */
const GHOST_SCALE = 1.04;
/** Keep the SCALED card off the screen edges. */
const GHOST_VIEWPORT_MARGIN_PX = 4;

/** EXPERIMENT (live reflow): instead of a drop line, the other blocks slide out
 * of the way while you drag, so the note already looks the way it will after
 * the drop, and the dimmed source block sits in its landing slot. Only for
 * top-level blocks; a list item keeps the drop line. Flip to false to get the
 * line back everywhere.
 *
 * The real document is never touched while dragging. Any style change on an
 * element inside the editor's scroll box costs Chromium a walk of the whole
 * note — on a 3,000-block note on a budget Android phone, 30-60ms a frame for
 * the transform of a dozen blocks, however few, with or without a transition
 * (measured 2026-10-07, block-drag-bench --device android). So the preview is
 * drawn on a "curtain": an opaque layer OUTSIDE the scroll box, over the
 * editor's visible area, holding clones of the blocks near the viewport. The
 * clones are shuffled with transforms, the curtain follows the scroll with one
 * transform of its own, and the real blocks underneath stay exactly as they
 * were. */
const LIVE_REFLOW = true;

/** The blocks within REFLOW_WINDOW_URGENT_VIEWPORTS of the visible area are
 * cloned in the frame that needs them; the rest of the window, out to
 * REFLOW_WINDOW_MARGIN_VIEWPORTS on each side, is cloned in idle time between
 * frames, a few at a time (`scheduleFill`). A clone is dropped once it is
 * REFLOW_WINDOW_DROP_VIEWPORTS away. Cloning a whole window in one frame cost
 * the frame that opened the curtain ~45ms on a budget phone, and a steady
 * auto-scroll a long frame every viewport. */
const REFLOW_WINDOW_URGENT_VIEWPORTS = 0.25;
const REFLOW_WINDOW_MARGIN_VIEWPORTS = 1.5;
const REFLOW_WINDOW_DROP_VIEWPORTS = 3;
/** Idle-time cloning stops with this much of the idle period left. */
const CURTAIN_FILL_RESERVE_MS = 2;
/** The longest the curtain waits for idle time after a lift. */
const CURTAIN_IDLE_OPEN_TIMEOUT_MS = 150;
/** The longest a pending idle fill waits. */
const CURTAIN_FILL_TIMEOUT_MS = 300;
/** Where there is no `requestIdleCallback` (`whenIdle`): how long to wait,
 * and how much time the stand-in idle period offers. */
const IDLE_FALLBACK_DELAY_MS = 32;
const IDLE_FALLBACK_SLICE_MS = 4;
const REFLOW_TRANSITION = 'transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1)';

interface Reflow {
  /** Top-level blocks at lift. */
  count: number;
  /** Each block's top, left, width and height in scroll-content coordinates
   * (immune to auto-scroll; `left` from the editor's left edge), measured on
   * first use: the real blocks never move during the drag, so a block measured
   * late is as right as one measured at lift, and a lift on a 3,000-block note
   * does not pay for 3,000 rect reads (~0.1ms each on a budget phone). NaN
   * means not yet measured. */
  tops: Float64Array;
  lefts: Float64Array;
  widths: Float64Array;
  heights: Float64Array;
  /** How far up each clone is drawn from its block's top (`collapsedTopMargin`),
   * read when the clone is planned. NaN until then. */
  insets: Float64Array;
  /** The scroll-content origin (`reflowOriginTop`) as of the current step. */
  originTop: number;
  /** The editor's left edge in client coordinates (it never scrolls sideways). */
  originLeft: number;
  sourceIndex: number;
  /** What scrolls the blocks, and the listener that moves the curtain. */
  scroller: HTMLElement | Window;
  onScroll: () => void;
  /** Fixed over the scroll box's visible area, clipping the curtain to it. */
  clip: HTMLElement;
  /** The editor's box in content coordinates, opaque, holding the clones. */
  curtain: HTMLElement;
  /** Where the clip and curtain go, measured at lift. */
  box: CurtainBox;
  /** Whether the curtain is up. It does not go up in the lift's own frame:
   * until something moves, the real document (with the source dimmed) already
   * looks exactly like the preview, so it goes up in the idle time after the
   * lift has been shown — while the finger holds still — or at the first gap
   * change, whichever comes first. */
  open: boolean;
  /** The pending idle open (`requestIdleCallback` id, or a timeout id). */
  idleOpen: number;
  /** The pending idle fill (`scheduleFill`), same kinds of id. */
  idleFill: number;
  /** Live clones by block index, with the shift (px) written on each. */
  clones: Map<number, { el: HTMLElement; shift: number }>;
  /** The gap index currently previewed, or null for "nothing moved". */
  applied: number | null;
  scrollFrame: number;
}

/** Where `placeCurtain` puts the clip (client coordinates) and the curtain
 * (relative to the clip), and what the curtain is painted with. */
interface CurtainBox {
  clip: { top: number; left: number; width: number; height: number };
  left: number;
  width: number;
  height: number;
  background: string;
}

interface CurtainWindowPlan {
  remove: number[];
  add: number[];
}

interface BlockDragSourceState {
  decorationSet: DecorationSet;
}

export const blockDragSourceKey = new PluginKey<BlockDragSourceState>('futo-block-drag-source');

/** Injected once per page (not per editor instance/mount) — the ghost and
 * indicator live outside the ProseMirror DOM (fixed-position), so their
 * styling can't ride along with the component's scoped `<style>` block. */
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-block-drag', '');
  style.textContent = `
    .futo-mobile-dnd-source { opacity: 0.35; transition: opacity 0.12s ease; }

    .futo-mobile-dnd-ghost {
      position: fixed;
      left: 0;
      top: 0;
      margin: 0;
      pointer-events: none;
      z-index: 1000;
      will-change: transform;
    }
    /* The card. Deliberately more specific (3 classes) than
     * '.futo-milkdown .ProseMirror' so the ProseMirror class it also carries
     * supplies the real content typography (headings, code, lists) while the
     * editor's own box rules — full height, internal scroller, 54px gutter —
     * are overridden here. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card.ProseMirror {
      box-sizing: border-box;
      width: 100%;
      height: auto;
      /* The cap itself is set inline from window.innerHeight — see
       * GHOST_MAX_HEIGHT_FRACTION for why it must not be written in vh. */
      overflow: hidden;
      padding: ${GHOST_PAD_Y_PX}px ${GHOST_PAD_X_PX}px;
      border-radius: 14px;
      /* Translucent on purpose: the card is drawn over the drop indicator
       * line and the dimmed source block, and both need to read through it.
       * Only the background is see-through — text stays fully opaque. */
      background: color-mix(in srgb, var(--color-surface, #f2f2f2) 80%, transparent);
      border: 1px solid var(--color-border, #e5e5e5);
      opacity: 0;
      transform: scale(0.97);
      transform-origin: 50% 40%;
      transition:
        transform 0.12s cubic-bezier(0.2, 0.9, 0.3, 1),
        opacity 0.12s ease;
    }
    /* Added on the next frame after insertion, so the card visibly POPS up
     * under the finger instead of appearing fully formed. */
    .futo-milkdown .futo-mobile-dnd-ghost--lifted .futo-mobile-dnd-ghost-card.ProseMirror {
      opacity: 1;
      transform: scale(${GHOST_SCALE});
    }
    /* The card's shadow, drawn ONCE onto a canvas at the lift (drawGhostShadow)
     * rather than as a box-shadow: WebKitGTK re-blurs a box-shadow every time
     * anything under it repaints, which cost a reflow drag ~8-14ms a frame. */
    .futo-mobile-dnd-ghost-shadow {
      position: absolute;
      pointer-events: none;
      opacity: 0;
      transform: scale(0.97);
      transition:
        transform 0.12s cubic-bezier(0.2, 0.9, 0.3, 1),
        opacity 0.12s ease;
    }
    .futo-mobile-dnd-ghost--lifted .futo-mobile-dnd-ghost-shadow {
      opacity: 1;
      transform: scale(${GHOST_SCALE});
    }
    /* Only when the block genuinely exceeds the height cap — an unconditional
     * mask would fade the bottom of every short block. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card--clipped {
      -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent 100%);
      mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent 100%);
    }
    /* The block's own leading margin belongs to the document flow, not to a
     * card that is already padded. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card.ProseMirror > * {
      margin-top: 0;
      margin-bottom: 0;
    }
    /* The source dim is a decoration on the live block; a clone taken while it
     * is applied would be a 35%-opacity ghost. Belt and braces on top of
     * cloning before the decoration is dispatched. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-source {
      opacity: 1;
    }

    /* Live reflow (LIVE_REFLOW): the clip sits over the scroll box's visible
     * area, under the ghost card; the curtain inside it carries the ProseMirror
     * class for the content typography, with the editor's box rules zeroed. */
    .futo-mobile-dnd-reflow-clip {
      position: fixed;
      overflow: hidden;
      pointer-events: none;
      z-index: 998;
    }
    .futo-milkdown .futo-mobile-dnd-reflow-clip .futo-mobile-dnd-reflow-curtain.ProseMirror {
      position: absolute;
      top: 0;
      box-sizing: border-box;
      min-height: 0;
      margin: 0;
      padding: 0;
      border: 0;
      overflow: visible;
      outline: none;
      will-change: transform;
    }
    /* Each clone on its own compositor layer, so its slide runs on the
     * compositor: without it Chromium ticked every sliding clone on the main
     * thread, 3-5ms a frame on a budget phone. */
    .futo-milkdown .futo-mobile-dnd-reflow-curtain.ProseMirror > * {
      position: absolute;
      box-sizing: border-box;
      margin: 0;
      transition: ${REFLOW_TRANSITION};
      will-change: transform;
    }
    .futo-milkdown .futo-mobile-dnd-reflow-curtain.ProseMirror > .futo-mobile-dnd-reflow-source {
      opacity: 0.35;
    }

    .futo-mobile-dnd-indicator {
      position: fixed;
      height: 3px;
      margin-top: -1.5px;
      border-radius: 2px;
      background: var(--color-primary, #f26b1f);
      pointer-events: none;
      /* Drawn UNDER the ghost card (z-index 1000): the card's background is
       * translucent (see .futo-mobile-dnd-ghost-card above), so the line
       * still reads through it instead of being fully hidden. */
      z-index: 999;
      opacity: 0;
      transition: opacity 0.08s ease;
    }
    .futo-mobile-dnd-indicator--visible { opacity: 1; }
  `;
  document.head.appendChild(style);
}

/** The Milkdown plugin behind the source-block dim: a plugin-state
 * `DecorationSet`, mapped through every transaction, that a session sets at
 * lift and clears at the end. WebKit's DOMObserver reverts a plain
 * `classList.add` on a node INSIDE the contenteditable (it "heals" the DOM back
 * to what ProseMirror's own render last produced), so the lifted block is dimmed
 * through a DECORATION, never a direct class mutation. Mounted once per editor
 * by `useBlockDragPlugins`, whichever gesture it got. */
export const blockDragSourcePlugin = $prose(
  () =>
    new Plugin<BlockDragSourceState>({
      key: blockDragSourceKey,
      state: {
        init: () => ({ decorationSet: DecorationSet.empty }),
        apply(tr, value) {
          const meta = tr.getMeta(blockDragSourceKey) as BlockDragSourceState | undefined;
          if (meta) return meta;
          if (tr.docChanged) return { decorationSet: value.decorationSet.map(tr.mapping, tr.doc) };
          return value;
        },
      },
      props: {
        decorations(state) {
          return blockDragSourceKey.getState(state)?.decorationSet ?? null;
        },
      },
    }),
);

/** One editor's block drag after the lift. Created by the gesture that owns the
 * editor view and kept for its lifetime: `start` → `move`* → `finish`/`cancel`. */
export class BlockDragSession {
  private readonly view: ProseView;
  private readonly doc: Document;
  private readonly options: BlockDragSessionOptions;

  private lifted: BlockDragLift | null = null;
  private lastY = 0;
  private liftX = 0;
  private liftY = 0;

  /** The boundary the indicator is currently drawn at. `pos` IS the boundary's
   * whole identity (blockDragGeometry.ts), so only a CHANGE of this fires
   * `onBoundaryChange`: a finger travelling inside one gap is silent, and
   * crossing from one block's lower half into the next block's upper half — the
   * same gap — is silent too, because the bar did not move. */
  private indicatorPos: number | null = null;

  /** Continuous edge auto-scroll while dragging. Owned per editor view and
   * stopped from every exit (`finish`, `cancel`, `destroy`). */
  private readonly autoScroll: DragAutoScroller;

  /** Non-null while the live-reflow preview drives this drag (LIVE_REFLOW). */
  private reflow: Reflow | null = null;

  private ghostEl: HTMLDivElement | null = null;
  private indicatorEl: HTMLDivElement | null = null;

  constructor(view: ProseView, options: BlockDragSessionOptions = {}) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    this.options = options;
    this.autoScroll = createDragAutoScroller(view, this.onAutoScrollStep);
    ensureStyles();
  }

  get active(): boolean {
    return this.lifted !== null;
  }

  /** Lifts `source`: dims it, draws the ghost over it and seeds the indicator.
   * `clientX/Y` is where the pointer is at the lift. */
  start(source: BlockDragLift, clientX: number, clientY: number): void {
    if (this.lifted) return;
    const view = this.view;
    this.lifted = source;
    this.lastY = clientY;

    // Every geometry read happens up here, before the dim is dispatched or
    // anything is drawn: a read after a write lays the whole note out again
    // (~17ms a time on a 3,000-block note on a budget phone).
    const liftRect = source.dom.getBoundingClientRect();
    this.reflow = LIVE_REFLOW ? this.measureReflow(source) : null;
    /* Seeded from where the block already is, so the hold itself is silent: the
     * first tick belongs to the first boundary the finger actually reaches.
     * A resting target that is one of the block's own boundaries seeds null
     * instead (isNoOpTarget), for the same reason `syncIndicator` clears it —
     * that boundary draws no line to begin with. */
    const restingTarget = this.computeTarget(clientY);

    const decorationSet = DecorationSet.create(view.state.doc, [
      Decoration.node(
        source.from,
        source.to,
        { class: 'futo-mobile-dnd-source' },
        { futoDragSource: true },
      ),
    ]);
    view.dispatch(view.state.tr.setMeta(blockDragSourceKey, { decorationSet }));
    if (this.reflow) {
      this.placeCurtain(this.reflow);
      this.scheduleIdleOpen(this.reflow);
    }
    this.indicatorPos =
      restingTarget && !this.isNoOpTarget(restingTarget) ? restingTarget.pos : null;
    this.createGhost(clientX, clientY, liftRect);
  }

  /** The pointer moved while lifted. */
  move(clientX: number, clientY: number): void {
    if (!this.lifted) return;
    this.lastY = clientY;
    this.updateGhostPosition(clientX, clientY);
    this.syncIndicator(clientY, true);
    this.autoScroll.update(clientY);
  }

  /**
   * Ends the drag: tears the visuals down, and when `commit` is true moves the
   * block to the gap under `clientY`. Returns true only when a transaction was
   * dispatched — a drop back at the source, or any refusal `moveBlock` makes,
   * is silent. `commit=false` is the cancel path (incoming calls, system
   * gestures, Escape) and cleans up exactly like a release, with no
   * transaction.
   *
   * `beforeDispatch` runs on the move transaction (after the dim is cleared in
   * it), for a gesture that needs to place the selection.
   */
  finish(
    clientY: number,
    commit: boolean,
    beforeDispatch?: (tr: Transaction, movedTo: number, range: BlockMoveRange) => void,
  ): boolean {
    const lifted = this.lifted;
    if (!lifted) return false;
    this.autoScroll.stop();

    // The target and the range are both read BEFORE the dim is cleared: the
    // range comes from the mapped decoration. The target is also read before
    // the visuals go, because ending the reflow preview switches `computeTarget`
    // back to the line geometry.
    const target = commit ? this.computeTarget(clientY) : null;
    this.cleanupDragVisuals();
    if (!target) {
      this.clearDecoration();
      this.reset();
      return false;
    }

    const range = this.currentSourceRange(lifted);
    // Every refusal case (stale range, a target that stopped being a legal
    // gap, a drop back at the source, a node ProseMirror would re-shape) lives
    // in moveBlock. A drop that commits nothing is silent: no transaction, no
    // history entry, no 'change'.
    const committed = moveBlock(this.view, range, target.pos, (tr, movedTo) => {
      // Same transaction as the move, so the source block is never drawn
      // dimmed for a frame at its new position.
      tr.setMeta(blockDragSourceKey, { decorationSet: DecorationSet.empty });
      beforeDispatch?.(tr, movedTo, range);
    });
    if (!committed) this.clearDecoration();
    this.reset();
    return committed;
  }

  /** Ends the drag with no transaction. */
  cancel(): void {
    this.finish(this.lastY, false);
  }

  /** The editor view is going away: the ghost and the loop must not outlive it. */
  destroy(): void {
    this.autoScroll.stop();
    this.cleanupDragVisuals();
    this.lifted = null;
  }

  private reset(): void {
    this.lifted = null;
    this.indicatorPos = null;
  }

  /** Redraws the drop indicator for `clientY`, notifying once per NEW boundary
   * when `tick` is true.
   *
   * Auto-scroll passes false. The finger is holding still while the document
   * sweeps past underneath it, and at auto-scroll speeds that is hundreds of
   * boundaries a second: a tick each would be one continuous buzz, and would
   * destroy the meaning of the tick, which is "you have put the bar somewhere
   * new". The spec already says a hold ticks nothing, and an auto-scroll IS a
   * hold. The key is still updated, so the first tick after the finger resumes
   * moving belongs to a genuinely new boundary rather than to one the eye
   * already saw slide by. */
  private syncIndicator(clientY: number, tick: boolean): void {
    if (this.reflow) {
      this.syncReflow(clientY, tick);
      return;
    }
    const target = this.computeTarget(clientY);
    if (!target || this.isNoOpTarget(target)) {
      // A no-op target (either of the lifted block's own two boundaries, or
      // nowhere resolvable) draws no line: `indicatorPos` is cleared rather
      // than left pointing at the no-op boundary, so the first tick after the
      // finger leaves this zone always belongs to the first genuinely new
      // boundary it reaches — never a spurious one for re-entering here, and
      // never one for the two no-op boundaries between each other.
      this.hideIndicator();
      this.indicatorPos = null;
      return;
    }
    this.showIndicator(target);
    if (target.pos === this.indicatorPos) return;
    this.indicatorPos = target.pos;
    if (tick) this.options.onBoundaryChange?.();
  }

  /** True when `target` is a no-op for the block currently lifted — i.e. one
   * of its own two boundaries (`isNoOpDrop`, shared with `moveBlock`). Guards
   * the indicator/haptic layer here; a release over a no-op target was already
   * a silent no-op via `moveBlock`, this only stops the line being drawn (and
   * the card overlapping it) while the pointer is still over the block it just
   * picked up. */
  private isNoOpTarget(target: DropTarget): boolean {
    return this.lifted !== null && isNoOpDrop(this.currentSourceRange(this.lifted), target.pos);
  }

  /** After every frame edge auto-scroll actually moved the scroller. The
   * pointer has not moved, so the ghost stays put — but the boundary UNDER it
   * has changed, and the indicator (and the position a release would commit to)
   * must be recomputed from the new geometry rather than assumed. */
  private onAutoScrollStep = (): void => {
    if (!this.lifted) return;
    this.syncIndicator(this.lastY, false);
  };

  /** The lifted block's CURRENT position decides which gaps it may land in
   * (blockDragGeometry.ts): the top-level gaps for a top-level block, the gaps
   * of its list for a list item. */
  private computeTarget(clientY: number): DropTarget | null {
    if (!this.lifted) return null;
    if (this.reflow) return this.reflowTarget(clientY);
    const source = dragSourceAt(this.view.state.doc, this.currentSourceRange(this.lifted).from);
    return source ? targetAtPointerY(this.view, clientY, source) : null;
  }

  /** The source block's CURRENT range. The decoration set is mapped through
   * every transaction (see the plugin's `apply`), so this survives anything
   * that edited the doc between the lift and release — autocorrect, a host
   * `setContent`, the trailing-paragraph plugin. The lift-time positions are
   * only the fallback. */
  private currentSourceRange(lifted: BlockDragLift): BlockMoveRange {
    const decorations = blockDragSourceKey.getState(this.view.state)?.decorationSet;
    const found = decorations?.find(
      undefined,
      undefined,
      (spec: { futoDragSource?: boolean }) => spec.futoDragSource === true,
    );
    if (found && found.length === 1) return { from: found[0].from, to: found[0].to };
    return { from: lifted.from, to: lifted.to };
  }

  /* ---- live reflow (LIVE_REFLOW) ----------------------------------------- */

  /** Sets up the preview for `source` — where the curtain goes; the blocks
   * themselves are measured as they are needed (`slotTop`) — or returns null
   * when this drag cannot be previewed (a list item, or a block without
   * rendered DOM). Reads only. */
  private measureReflow(source: BlockDragLift): Reflow | null {
    const view = this.view;
    const doc = view.state.doc;
    if (doc.resolve(source.from).depth !== 0) return null;
    // Cloning by index needs the DOM children to be exactly the doc's blocks,
    // in order (a widget or a foreign node would shift every clone).
    if (view.dom.children.length !== doc.childCount) return null;
    // Each block's own view descriptor, not `view.nodeDOM(offset)`: nodeDOM
    // walks the blocks from the top on every call, which made this check
    // quadratic — 150-250ms on a 3,000-block note on a budget phone.
    const blocks = view.dom.children;
    let sourceIndex = -1;
    let ok = true;
    doc.forEach((node, offset, index) => {
      const desc = (blocks[index] as { pmViewDesc?: { node?: unknown } } | undefined)?.pmViewDesc;
      if (desc?.node !== node) ok = false;
      if (offset === source.from) sourceIndex = index;
    });
    if (!ok || sourceIndex < 0) return null;
    const count = doc.childCount;
    const unmeasured = () => new Float64Array(count).fill(NaN);
    const scroller = this.scrollContainer();
    const win = this.doc.defaultView ?? window;
    const visible =
      scroller instanceof HTMLElement
        ? visibleBox(scroller)
        : { top: 0, left: 0, width: win.innerWidth, height: win.innerHeight };
    const viewRect = view.dom.getBoundingClientRect();
    const clip = this.doc.createElement('div');
    clip.className = 'futo-mobile-dnd-reflow-clip';
    clip.setAttribute('aria-hidden', 'true');
    const curtain = this.doc.createElement('div');
    // `ProseMirror` so the editor's own content typography applies to the
    // clones; the curtain rules above override the editor's BOX rules.
    curtain.className = 'futo-mobile-dnd-reflow-curtain ProseMirror';
    clip.appendChild(curtain);
    return {
      count,
      tops: unmeasured(),
      lefts: unmeasured(),
      widths: unmeasured(),
      heights: unmeasured(),
      insets: unmeasured(),
      originTop: this.reflowOriginTop(),
      originLeft: viewRect.left,
      sourceIndex,
      scroller,
      onScroll: () => this.onReflowScroll(),
      clip,
      curtain,
      box: {
        clip: visible,
        left: viewRect.left - visible.left,
        width: viewRect.width,
        height: Math.max(view.dom.scrollHeight, viewRect.height),
        background: backgroundBehind(view.dom),
      },
      open: false,
      idleOpen: 0,
      idleFill: 0,
      clones: new Map(),
      applied: null,
      scrollFrame: 0,
    };
  }

  /** Opens the curtain once the lift's frame is out (see `Reflow.open`). */
  private scheduleIdleOpen(reflow: Reflow): void {
    reflow.idleOpen = this.whenIdle(() => {
      reflow.idleOpen = 0;
      if (this.reflow !== reflow || reflow.open) return;
      reflow.originTop = this.reflowOriginTop();
      this.openCurtain(reflow, this.planCurtainWindow(reflow));
    }, CURTAIN_IDLE_OPEN_TIMEOUT_MS);
  }

  /** Clones the rest of the window (out to REFLOW_WINDOW_MARGIN_VIEWPORTS) in
   * idle time, as many as each idle period has room for. */
  private scheduleFill(reflow: Reflow): void {
    if (reflow.idleFill) return;
    reflow.idleFill = this.whenIdle((deadline) => {
      reflow.idleFill = 0;
      if (this.reflow !== reflow || !reflow.open) return;
      reflow.originTop = this.reflowOriginTop();
      const { add } = this.planCurtainWindow(reflow, REFLOW_WINDOW_MARGIN_VIEWPORTS);
      let done = 0;
      while (
        done < add.length &&
        (done === 0 || deadline.timeRemaining() > CURTAIN_FILL_RESERVE_MS)
      ) {
        this.addClone(reflow, add[done]);
        done += 1;
      }
      if (done < add.length) this.scheduleFill(reflow);
    }, CURTAIN_FILL_TIMEOUT_MS);
  }

  /** `requestIdleCallback`, or — in WebKit, which has none (WebKitGTK 2.4x,
   * and so desktop Linux and iOS) — a short timeout handing `run` a time slice
   * of the same shape. */
  private whenIdle(run: (deadline: { timeRemaining(): number }) => void, timeout: number): number {
    const win = (this.doc.defaultView ?? window) as Window & {
      requestIdleCallback?: (
        cb: (deadline: { timeRemaining(): number }) => void,
        opts: { timeout: number },
      ) => number;
    };
    if (win.requestIdleCallback) return win.requestIdleCallback(run, { timeout });
    return win.setTimeout(() => {
      const end = performance.now() + IDLE_FALLBACK_SLICE_MS;
      run({ timeRemaining: () => Math.max(0, end - performance.now()) });
    }, IDLE_FALLBACK_DELAY_MS);
  }

  /** Draws the curtain over the editor with its first window of clones.
   * Writes only: `measureReflow` and `planCurtainWindow` did the reading. */
  private openCurtain(reflow: Reflow, plan: CurtainWindowPlan): void {
    reflow.open = true;
    this.cancelIdleOpen(reflow);
    reflow.curtain.style.background = reflow.box.background;
    reflow.curtain.style.transform = `translateY(${reflow.originTop - reflow.box.clip.top}px)`;
    this.applyCurtainWindow(reflow, plan);
    reflow.scroller.addEventListener('scroll', reflow.onScroll, { passive: true });
  }

  /** Puts the (still empty, transparent) clip and curtain in place at the
   * lift, in the lift's own write phase. Appending them later, inside the
   * editor's container, made the frame that opened the curtain lay the whole
   * note out again (~36ms a time on a 3,000-block note on a budget phone).
   * (`contain: strict` on the clip, tried to keep later changes inside it, made
   * every drop 2-3x slower instead.) */
  private placeCurtain(reflow: Reflow): void {
    const { clip, curtain, box } = reflow;
    clip.style.top = `${box.clip.top}px`;
    clip.style.left = `${box.clip.left}px`;
    clip.style.width = `${box.clip.width}px`;
    clip.style.height = `${box.clip.height}px`;
    curtain.style.left = `${box.left}px`;
    curtain.style.width = `${box.width}px`;
    curtain.style.height = `${box.height}px`;
    this.ghostHost().appendChild(clip);
  }

  /** The nearest scrollable ancestor of the editor DOM (`.note-body` on
   * desktop), or the editor DOM itself where that is what scrolls. */
  private scrollContainer(): HTMLElement | Window {
    const win = this.doc.defaultView ?? window;
    for (let n: HTMLElement | null = this.view.dom; n; n = n.parentElement) {
      const overflowY = win.getComputedStyle(n).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
      if (n === this.view.dom && n.scrollHeight <= n.clientHeight) continue;
      return n;
    }
    return win;
  }

  /** The scroll-content origin in client coordinates: a slot's `top` plus this
   * is where it sits on screen right now. */
  private reflowOriginTop(): number {
    const scroller = this.view.dom;
    return scroller.getBoundingClientRect().top - scroller.scrollTop;
  }

  /** Block `i`'s top in scroll-content coordinates; `i === count` is the
   * bottom of the last block's slot. */
  private slotTop(i: number): number {
    const reflow = this.reflow!;
    if (i >= reflow.count) return this.slotTop(reflow.count - 1) + this.slotSize(reflow.count - 1);
    if (Number.isNaN(reflow.tops[i])) {
      const el = this.view.dom.children[i] as HTMLElement;
      const rect = el.getBoundingClientRect();
      reflow.tops[i] = rect.top - reflow.originTop;
      reflow.lefts[i] = rect.left - reflow.originLeft;
      reflow.widths[i] = rect.width;
      reflow.heights[i] = rect.height;
    }
    return reflow.tops[i];
  }

  /** Block `i` plus the gap below it: how far its neighbours move when it
   * leaves. The last block has no gap below, so it borrows the one above. */
  private slotSize(i: number): number {
    const reflow = this.reflow!;
    if (i + 1 < reflow.count) return this.slotTop(i + 1) - this.slotTop(i);
    const top = this.slotTop(i);
    const height = reflow.heights[i];
    if (i === 0) return height;
    return height + Math.max(0, top - (this.slotTop(i - 1) + reflow.heights[i - 1]));
  }

  /** The first block index in [0, count] for which `past(i)` is false, for a
   * `past` that is true up to some index and false after it. */
  private firstNotPast(past: (i: number) => boolean): number {
    let lo = 0;
    let hi = this.reflow!.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (past(mid)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The gap index (0..n) under `clientY`, judged against the LIFT-TIME layout
   * so blocks sliding under the pointer can't flip the answer back and forth. */
  private reflowGapAt(clientY: number): number {
    const reflow = this.reflow!;
    const scroller = this.view.dom;
    const rect = scroller.getBoundingClientRect();
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    reflow.originTop = rect.top - scroller.scrollTop;
    const contentY = y - reflow.originTop;
    return this.firstNotPast((i) => this.slotTop(i) + this.slotSize(i) / 2 < contentY);
  }

  private reflowTarget(clientY: number): DropTarget | null {
    const gap = this.reflowGapAt(clientY);
    const doc = this.view.state.doc;
    let pos = doc.content.size;
    doc.forEach((_node, offset, index) => {
      if (index === gap) pos = offset;
    });
    // `dom`/`indicator` are only read by the line, which reflow never draws.
    return { pos, dom: this.view.dom, indicator: { top: 0, left: 0, width: 0 } };
  }

  private syncReflow(clientY: number, tick: boolean): void {
    const reflow = this.reflow!;
    const gap = this.reflowGapAt(clientY);
    const s = reflow.sourceIndex;
    const effective = gap === s || gap === s + 1 ? null : gap;
    if (effective === reflow.applied) return;
    if (this.view.state.doc.childCount !== reflow.count) {
      // The doc changed shape under the drag: stop previewing, keep the line.
      this.endReflow();
      return;
    }
    if (!reflow.open) {
      reflow.applied = effective;
      if (effective === null) return;
      // Both windows are planned (read) before anything is written: the one
      // the curtain opens with — nothing moved yet, so it matches the page —
      // and the one for this gap.
      reflow.applied = null;
      const opening = this.planCurtainWindow(reflow);
      reflow.applied = effective;
      const target = this.planCurtainWindow(reflow);
      this.openCurtain(reflow, opening);
      // Resolve the new clones' resting style now (one style pass covers them
      // all), so the shifts written below slide from it instead of snapping.
      void getComputedStyle(reflow.curtain.lastElementChild ?? reflow.curtain).transform;
      this.applyShifts(reflow);
      this.applyCurtainWindow(reflow, {
        remove: [],
        add: target.add.filter((i) => !reflow.clones.has(i)),
      });
      if (tick) this.options.onBoundaryChange?.();
      return;
    }
    reflow.applied = effective;
    const plan = this.planCurtainWindow(reflow);
    this.applyShifts(reflow);
    this.applyCurtainWindow(reflow, plan);
    if (tick && effective !== null) this.options.onBoundaryChange?.();
  }

  /** Writes each clone's shift for the current preview — only the ones that
   * changed: a gap change moves the blocks between the old gap and the new
   * one, not the whole window. */
  private applyShifts(reflow: Reflow): void {
    const moves: Array<[{ el: HTMLElement; shift: number }, number]> = [];
    for (const [index, clone] of reflow.clones) {
      const shift = this.reflowShift(index, reflow.applied);
      if (shift !== clone.shift) moves.push([clone, shift]);
    }
    for (const [clone, shift] of moves) {
      clone.el.style.transform = `translateY(${shift}px)`;
      clone.shift = shift;
    }
  }

  /** How far block `i` sits from its natural place with `gap` previewed: the
   * blocks between the source and `gap` shift by the source's size, and the
   * source slides to its landing slot. */
  private reflowShift(i: number, gap: number | null): number {
    const { sourceIndex: s } = this.reflow!;
    if (gap === null) return 0;
    if (gap > s + 1) {
      // The source's travel is the slots between it and the gap, which
      // telescope to a difference of two tops.
      if (i === s) return this.slotTop(gap) - this.slotTop(s + 1);
      return i > s && i < gap ? -this.slotSize(s) : 0;
    }
    if (gap < s) {
      if (i === s) return this.slotTop(gap) - this.slotTop(s);
      return i >= gap && i < s ? this.slotSize(s) : 0;
    }
    return 0;
  }

  /** Moves the curtain to the current scroll position and brings its window
   * of clones up to date. */
  private followScroll(reflow: Reflow): void {
    reflow.originTop = this.reflowOriginTop();
    const plan = this.planCurtainWindow(reflow);
    reflow.curtain.style.transform = `translateY(${reflow.originTop - reflow.box.clip.top}px)`;
    this.applyCurtainWindow(reflow, plan);
  }

  /** Which clones to drop and which blocks to clone so the window covers the
   * blocks whose CURRENT (shifted) position is within `viewports` viewport
   * heights of the visible area (REFLOW_WINDOW_URGENT_VIEWPORTS). Reads only —
   * every slot the writes will need is measured here. */
  private planCurtainWindow(
    reflow: Reflow,
    viewports = REFLOW_WINDOW_URGENT_VIEWPORTS,
  ): CurtainWindowPlan {
    const { clones, sourceIndex } = reflow;
    const viewport = window.innerHeight || this.doc.documentElement.clientHeight;
    const near = (i: number, within: number) => {
      const margin = viewport * within;
      const top = this.slotTop(i) + this.reflowShift(i, reflow.applied);
      return (
        top + this.slotSize(i) >= -reflow.originTop - margin &&
        top <= viewport - reflow.originTop + margin
      );
    };
    const remove = [...clones.keys()].filter((i) => !near(i, REFLOW_WINDOW_DROP_VIEWPORTS));
    const add: number[] = [];
    const missing = (within: number) => {
      const margin = viewport * within;
      const visTop = -reflow.originTop - margin;
      const visBottom = viewport - reflow.originTop + margin;
      // Every block but the source moves by at most the source's own size, so
      // the window's blocks are the ones within that much of it, found by a
      // binary search — plus the source, wherever its landing slot is.
      const reach = reflow.applied === null ? 0 : this.slotSize(sourceIndex);
      const first = this.firstNotPast((i) => this.slotTop(i) + this.slotSize(i) + reach < visTop);
      const out: number[] = [];
      for (let i = first; i < reflow.count && this.slotTop(i) - reach <= visBottom; i += 1) {
        if (i !== sourceIndex && !clones.has(i) && near(i, within)) out.push(i);
      }
      if (!clones.has(sourceIndex) && near(sourceIndex, within)) out.push(sourceIndex);
      return out;
    };
    add.push(...missing(viewports));
    // Shifts the writes will ask for (the source's travel reads two slots).
    for (const i of add) {
      this.reflowShift(i, reflow.applied);
      if (Number.isNaN(reflow.insets[i])) {
        reflow.insets[i] = collapsedTopMargin(this.view.dom.children[i] as HTMLElement);
      }
    }
    return { remove, add };
  }

  /** Writes a `planCurtainWindow` result: new clones go in already at their
   * target shift, so they never animate in. */
  private applyCurtainWindow(reflow: Reflow, plan: CurtainWindowPlan): void {
    for (const i of plan.remove) {
      reflow.clones.get(i)?.el.remove();
      reflow.clones.delete(i);
    }
    for (const i of plan.add) this.addClone(reflow, i);
    this.scheduleFill(reflow);
  }

  private addClone(reflow: Reflow, i: number): void {
    const live = this.view.dom.children[i];
    if (!(live instanceof HTMLElement)) return;
    const clone = live.cloneNode(true) as HTMLElement;
    clone.classList.remove('futo-mobile-dnd-source');
    for (const dimmed of Array.from(clone.querySelectorAll('.futo-mobile-dnd-source'))) {
      dimmed.classList.remove('futo-mobile-dnd-source');
    }
    if (i === reflow.sourceIndex) clone.classList.add('futo-mobile-dnd-reflow-source');
    const shift = this.reflowShift(i, reflow.applied);
    clone.style.top = `${this.slotTop(i) - reflow.insets[i]}px`;
    clone.style.left = `${reflow.lefts[i]}px`;
    clone.style.width = `${reflow.widths[i]}px`;
    clone.style.transform = `translateY(${shift}px)`;
    reflow.curtain.appendChild(clone);
    reflow.clones.set(i, { el: clone, shift });
  }

  private onReflowScroll(): void {
    const reflow = this.reflow;
    if (!reflow || reflow.scrollFrame) return;
    reflow.scrollFrame = requestAnimationFrame(() => {
      reflow.scrollFrame = 0;
      if (this.reflow === reflow && reflow.open) this.followScroll(reflow);
    });
  }

  private cancelIdleOpen(reflow: Reflow): void {
    this.cancelIdle(reflow.idleOpen);
    reflow.idleOpen = 0;
  }

  private cancelIdle(id: number): void {
    if (!id) return;
    const win = (this.doc.defaultView ?? window) as Window & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (win.cancelIdleCallback) win.cancelIdleCallback(id);
    else win.clearTimeout(id);
  }

  /** Takes the curtain down and ends the preview. Every exit calls it;
   * `finish` does so before dispatching the move, in the same synchronous step,
   * so no stale preview is painted over the result. */
  private endReflow(): void {
    const reflow = this.reflow;
    if (!reflow) return;
    this.cancelIdleOpen(reflow);
    this.cancelIdle(reflow.idleFill);
    cancelAnimationFrame(reflow.scrollFrame);
    reflow.scroller.removeEventListener('scroll', reflow.onScroll);
    reflow.clip.remove();
    this.reflow = null;
  }

  /** The ghost host is the `.futo-milkdown` container (OUTSIDE the
   * contenteditable, so no DOMObserver interference) rather than document.body:
   * the card carries the `ProseMirror` class, and the component's scoped
   * `.futo-milkdown .ProseMirror <element>` typography only applies inside
   * that container. Under document.body the clone rendered with bare UA
   * styling — the "too timid" preview. */
  private ghostHost(): HTMLElement {
    return this.view.dom.closest('.futo-milkdown') ?? this.doc.body;
  }

  /** `rect` is the lifted block's, read before anything was drawn. */
  private createGhost(clientX: number, clientY: number, rect: DOMRect): void {
    const lifted = this.lifted;
    if (!lifted) return;

    const clone = lifted.clone;
    clone.classList.remove('futo-mobile-dnd-source');
    for (const dimmed of Array.from(clone.querySelectorAll('.futo-mobile-dnd-source'))) {
      dimmed.classList.remove('futo-mobile-dnd-source');
    }

    const card = this.doc.createElement('div');
    // `ProseMirror` so the editor's own content typography applies to the
    // clone; the card rules above override the editor's BOX rules.
    card.className = 'futo-mobile-dnd-ghost-card ProseMirror';
    // In pixels, never `vh` (GHOST_MAX_HEIGHT_FRACTION): the native hosts' web
    // view resolves viewport units against a zero-height containing block.
    const viewportHeight = window.innerHeight || this.doc.documentElement.clientHeight;
    card.style.maxHeight = `${Math.round(viewportHeight * GHOST_MAX_HEIGHT_FRACTION)}px`;
    card.appendChild(clone);

    const ghost = this.doc.createElement('div');
    ghost.className = 'futo-mobile-dnd-ghost';
    ghost.setAttribute('aria-hidden', 'true');

    // Essentially full block width, grown by the card's own padding so the
    // content stays put under the finger, then clamped so the SCALED card
    // still clears both screen edges (the scale grows it about its centre, so
    // half the growth bleeds out of each side).
    const viewportWidth = window.innerWidth || rect.width + GHOST_PAD_X_PX * 2;
    const usable = viewportWidth - GHOST_VIEWPORT_MARGIN_PX * 2;
    const width = Math.min(rect.width + GHOST_PAD_X_PX * 2, usable / GHOST_SCALE);
    const bleed = (width * (GHOST_SCALE - 1)) / 2;
    const minLeft = GHOST_VIEWPORT_MARGIN_PX + bleed;
    const left = Math.min(
      Math.max(minLeft, rect.left - GHOST_PAD_X_PX),
      Math.max(minLeft, viewportWidth - GHOST_VIEWPORT_MARGIN_PX - bleed - width),
    );
    ghost.style.width = `${width}px`;
    ghost.style.left = `${left}px`;
    ghost.style.top = `${rect.top - GHOST_PAD_Y_PX}px`;
    ghost.appendChild(card);

    this.ghostHost().appendChild(ghost);
    this.ghostEl = ghost;
    drawGhostShadow(ghost, card);

    // Fade the bottom out ONLY when the block actually overflows the cap.
    if (card.scrollHeight - card.clientHeight > 1) {
      card.classList.add('futo-mobile-dnd-ghost-card--clipped');
    }
    // Next frame, so the 120ms pop transition has a start state to run from.
    requestAnimationFrame(() => ghost.classList.add('futo-mobile-dnd-ghost--lifted'));

    this.liftX = clientX;
    this.liftY = clientY;
  }

  private updateGhostPosition(clientX: number, clientY: number): void {
    if (!this.ghostEl) return;
    const dx = clientX - this.liftX;
    const dy = clientY - this.liftY;
    // Translation lives on the OUTER element and the pop scale on the inner
    // card, so dragging is never animated through the card's 120ms transition.
    this.ghostEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private ensureIndicator(): HTMLDivElement {
    if (!this.indicatorEl) {
      const el = this.doc.createElement('div');
      el.className = 'futo-mobile-dnd-indicator';
      el.setAttribute('aria-hidden', 'true');
      this.doc.body.appendChild(el);
      this.indicatorEl = el;
    }
    return this.indicatorEl;
  }

  /** One line per boundary, drawn IN the gap — the geometry is the target's, so
   * a gap approached from either side puts the bar in exactly one place
   * (blockDragGeometry.ts). The `margin-top` in the stylesheet re-centres the
   * 3px bar on `top`. */
  private showIndicator(target: DropTarget): void {
    const el = this.ensureIndicator();
    el.style.left = `${target.indicator.left}px`;
    el.style.width = `${target.indicator.width}px`;
    el.style.top = `${target.indicator.top}px`;
    el.classList.add('futo-mobile-dnd-indicator--visible');
  }

  private hideIndicator(): void {
    this.indicatorEl?.classList.remove('futo-mobile-dnd-indicator--visible');
  }

  private cleanupDragVisuals(): void {
    this.endReflow();
    this.ghostEl?.remove();
    this.ghostEl = null;
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }

  private clearDecoration(): void {
    const view = this.view;
    view.dispatch(
      view.state.tr.setMeta(blockDragSourceKey, { decorationSet: DecorationSet.empty }),
    );
  }
}

/** `el`'s padding box in client coordinates: what of its content is visible,
 * without its scrollbars. */
function visibleBox(el: HTMLElement): { top: number; left: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top + el.clientTop,
    left: rect.left + el.clientLeft,
    width: el.clientWidth,
    height: el.clientHeight,
  };
}

/** The first opaque-ish background at or above `el`: what the editor's text
 * is drawn on, so the curtain hides the real blocks without a seam. */
/** How far the top margin of `el`'s first descendants reaches out through its
 * top edge. In the document that margin collapses OUTSIDE the block (a list's
 * first item, say), so the block's top is its content's top; a clone is
 * absolutely positioned — a formatting context of its own — which keeps the
 * margin inside and would draw the content that much lower (2.5px for a list
 * on the reference phone) unless the clone is raised by it. */
function collapsedTopMargin(el: HTMLElement): number {
  const win = el.ownerDocument.defaultView ?? window;
  let through = 0;
  for (let n: Element = el; ;) {
    const style = win.getComputedStyle(n);
    if (n !== el) through = Math.max(through, parseFloat(style.marginTop) || 0);
    const contained =
      (style.display !== 'block' && style.display !== 'list-item') ||
      style.overflowY !== 'visible' ||
      parseFloat(style.paddingTop) > 0 ||
      parseFloat(style.borderTopWidth) > 0;
    let first = n.firstChild;
    while (first && first.nodeType === Node.TEXT_NODE && !first.textContent?.trim()) {
      first = first.nextSibling;
    }
    if (contained || !(first instanceof Element)) return through;
    n = first;
  }
}

function backgroundBehind(el: HTMLElement): string {
  const win = el.ownerDocument.defaultView ?? window;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const color = win.getComputedStyle(n).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '#fff';
}

/** The card's three box-shadows (the old CSS values), as [offsetY, blur, alpha]. */
const GHOST_SHADOWS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 2, 0.12],
  [6, 14, 0.16],
  [20, 44, 0.24],
];
const GHOST_RADIUS_PX = 14;

/** Paints the card's shadow once, onto a canvas behind it, sized to the card's
 * laid-out box plus room for the widest blur. The card is translucent and a
 * box-shadow is never drawn under its own box, so the card's area is cut back
 * out of the canvas. */
function drawGhostShadow(ghost: HTMLElement, card: HTMLElement): void {
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const margin = Math.max(...GHOST_SHADOWS.map(([y, blur]) => y + blur)) + 4;
  const dpr = window.devicePixelRatio || 1;
  const canvas = ghost.ownerDocument.createElement('canvas');
  canvas.className = 'futo-mobile-dnd-ghost-shadow';
  canvas.width = Math.ceil((width + margin * 2) * dpr);
  canvas.height = Math.ceil((height + margin * 2) * dpr);
  canvas.style.width = `${width + margin * 2}px`;
  canvas.style.height = `${height + margin * 2}px`;
  canvas.style.left = `${-margin}px`;
  canvas.style.top = `${-margin}px`;
  // The card scales about (50%, 40%) of ITSELF; the canvas is the card plus a
  // margin all round, so the same point sits `margin` further in.
  canvas.style.transformOrigin = `50% ${margin + height * 0.4}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Shadows are drawn by an off-canvas shape whose shadow is offset back into
  // view, so only the shadow lands. Shadow offset and blur ignore the
  // transform, hence the explicit device-pixel factors.
  const away = canvas.width + 1000;
  for (const [offsetY, blur, alpha] of GHOST_SHADOWS) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
    ctx.shadowBlur = blur * dpr;
    ctx.shadowOffsetX = away;
    ctx.shadowOffsetY = offsetY * dpr;
    ctx.beginPath();
    ctx.roundRect(
      margin * dpr - away,
      margin * dpr,
      width * dpr,
      height * dpr,
      GHOST_RADIUS_PX * dpr,
    );
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(margin * dpr, margin * dpr, width * dpr, height * dpr, GHOST_RADIUS_PX * dpr);
  ctx.fill();
  ghost.insertBefore(canvas, ghost.firstChild);
}
