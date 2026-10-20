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
 * The source range is always a top-level block, and it only lands in a
 * top-level gap (`blockDragGeometry.ts`).
 *
 * Gating: `blockDragSourcePlugin` is mounted for every editor (it is only the
 * state behind the dim); a session is created by whichever gesture the editor
 * got (`blockDragMode.ts`).
 */
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  createDragAutoScroller,
  type DragAutoScroller,
  type DropTarget,
} from './blockDragGeometry';
import { moveBlock, planBlockMove, type BlockMoveRange } from './blockMove';
import { ReflowCurtain } from './blockDragCurtain';
import { blockDragSourceKey, landingDrops } from './blockDragSource';
import { ensureStyles } from './blockDragSessionStyles';
import { BlockDragTargeting } from './blockDragTargeting';
import { PENDING_EDIT_META } from './documentChanges';
import { beginInteraction, endInteraction, markInteraction } from '$shared/perf/interactionLedger';

export { GHOST_PAD_Y_PX } from './blockDragVisuals';
export {
  blockDragSourceKey,
  blockDragSourcePlugin,
  dropLanding,
  landPendingDrop,
} from './blockDragSource';

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

/** One editor's block drag after the lift. Created by the gesture that owns the
 * editor view and kept for its lifetime: `start` → `move`* → `finish`/`cancel`. */
export class BlockDragSession extends BlockDragTargeting {
  /** A released drop whose move is not committed yet (`land`). */
  private landing: {
    curtain: ReflowCurtain;
    lifted: BlockDragLift;
    beforeDispatch?: (tr: Transaction, movedTo: number, range: BlockMoveRange) => void;
  } | null = null;

  /** Continuous edge auto-scroll while dragging. Owned per editor view and
   * stopped from every exit (`finish`, `cancel`, `destroy`). */
  private readonly autoScroll: DragAutoScroller;

  constructor(view: ProseView, options: BlockDragSessionOptions = {}) {
    super(view, options);
    this.autoScroll = createDragAutoScroller(view, this.onAutoScrollStep);
    ensureStyles();
  }

  get active(): boolean {
    return this.lifted !== null;
  }

  /** Whether a released drop is still landing (`land`): no new drag may lift
   * until it has committed, since the lift would cut its slide short and
   * measure the note before the move. */
  get landingDrop(): boolean {
    return this.landing !== null;
  }

  /** Lifts `source`: dims it, draws the ghost over it and seeds the indicator.
  /** Lifts `source`: dims it, draws the ghost over it and seeds the indicator.
   * `clientX/Y` is where the pointer is at the lift. */
  start(source: BlockDragLift, clientX: number, clientY: number): void {
    // The gestures do not lift while a drop lands (`landingDrop`); this is
    // the guarantee.
    if (this.lifted || this.landing) return;
    // The interaction ledger (interactionLedger.ts): lift → lifted → dropped.
    beginInteraction('block-drag');
    const view = this.view;
    this.lifted = source;
    this.lastY = clientY;

    // Every geometry read happens up here, before the dim is dispatched or
    // anything is drawn: a read after a write lays the whole note out again
    // (~17ms a time on a 3,000-block note on a budget phone).
    const liftRect = source.dom.getBoundingClientRect();
    this.reflow = ReflowCurtain.measure(view, this.ghostHost(), source, () =>
      this.options.onBoundaryChange?.(),
    );
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
    try {
      view.dispatch(view.state.tr.setMeta(blockDragSourceKey, { decorationSet }));
      this.reflow?.mount();
      this.indicatorPos =
        restingTarget && !this.isNoOpTarget(restingTarget) ? restingTarget.pos : null;
      this.createGhost(clientX, clientY, liftRect);
      markInteraction('block-drag', 'lifted');
    } catch (error) {
      // A lift that throws half-way (an engine missing some API) must not
      // strand the dim, the curtain or the ghost: callers only treat the drag
      // as live once `start` returns, so nothing else would ever clear them.
      this.cleanupDragVisuals();
      this.reset();
      endInteraction('block-drag');
      this.clearDecoration();
      throw error;
    }
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
    markInteraction('block-drag', commit ? 'released' : 'cancelled');

    // The target and the range are both read BEFORE the dim is cleared: the
    // range comes from the mapped decoration. The target is also read before
    // the visuals go, because ending the reflow preview switches `computeTarget`
    // back to the line geometry.
    let target: DropTarget | null = null;
    // The reflow preview of a release that will commit: the move lands under
    // it (`land`).
    let curtain: ReflowCurtain | null = null;
    try {
      target = commit ? this.computeTarget(clientY, true) : null;
    } catch (error) {
      this.clearDecoration();
      throw error;
    } finally {
      // Whatever the read does, the visuals and the lift state go: a throw
      // here must not leave the curtain and ghost mounted.
      if (target) {
        curtain = this.reflow;
        this.reflow = null;
      }
      this.cleanupDragVisuals();
      this.reset();
      // A drop in flight keeps the record open until the guard below.
      if (!target) endInteraction('block-drag');
    }
    const range = target ? this.currentSourceRange(lifted) : null;
    // Every refusal case (stale range, a target that stopped being a legal
    // gap, a drop back at the source, a node ProseMirror would re-shape) lives
    // in moveBlock. A drop that commits nothing is silent: no transaction, no
    // history entry, no 'change'.
    if (!target || !range || !planBlockMove(this.view.state, range, target.pos)) {
      endInteraction('block-drag');
      curtain?.end();
      this.clearDecoration();
      return false;
    }
    markInteraction('block-drag', 'dropped');
    endInteraction('block-drag');
    if (curtain) {
      this.land(curtain, lifted, target.pos, beforeDispatch);
      return true;
    }
    return this.commit(range, target.pos, beforeDispatch);
  }

  /** Moves `range` to `pos` in one transaction that also clears the dim. */
  private commit(
    range: BlockMoveRange,
    pos: number,
    beforeDispatch?: (tr: Transaction, movedTo: number, range: BlockMoveRange) => void,
  ): boolean {
    const committed = moveBlock(this.view, range, pos, (tr, movedTo) => {
      // Same transaction as the move, so the source block is never drawn
      // dimmed for a frame at its new position.
      tr.setMeta(blockDragSourceKey, { decorationSet: DecorationSet.empty });
      beforeDispatch?.(tr, movedTo, range);
    });
    if (!committed) this.clearDecoration();
    return committed;
  }

  /** A release that will commit the move the reflow preview shows. Its
   * neighbours may still be sliding to their places, and committing now would
   * take the curtain down and make them jump the rest of the way, so the move
   * waits under the curtain until they are there (`ReflowCurtain.land`), then
   * commits and the curtain goes, in one frame: nothing moves on screen but
   * the dropped block, and no real block is ever animated (a style change
   * inside the editor's scroll box restyles the whole note). The target is
   * kept in the source plugin's state, so a document change in the meantime
   * maps it (`docChanged`). The release is reported as an edit at once
   * (`PENDING_EDIT_META`); `landPendingDrop` commits the move early for
   * anything that reads or saves the note. */
  private land(
    curtain: ReflowCurtain,
    lifted: BlockDragLift,
    pos: number,
    beforeDispatch?: (tr: Transaction, movedTo: number, range: BlockMoveRange) => void,
  ): void {
    const source = blockDragSourceKey.getState(this.view.state);
    this.view.dispatch(
      this.view.state.tr
        .setMeta(blockDragSourceKey, {
          decorationSet: source?.decorationSet ?? DecorationSet.empty,
          dropTarget: pos,
        })
        .setMeta(PENDING_EDIT_META, true),
    );
    this.landing = { curtain, lifted, beforeDispatch };
    landingDrops.set(this.view.dom, this);
    curtain.land(() => this.landed());
  }

  /** The landing drop's neighbours are in place (or the layout changed, or
   * the note scrolled, or the document changed, or something reads the note:
   * `landPendingDrop`): the move commits, at its target mapped through
   * anything that happened since, and the curtain goes in the same frame. A move that no longer applies (its block was taken
   * away) is dropped. Only the mapped dim decoration names the block here,
   * never the lift-time positions: after a note switch those could name a
   * block of the new note. */
  landed(): void {
    const landing = this.landing;
    if (!landing) return;
    this.landing = null;
    landingDrops.delete(this.view.dom);
    let committed = false;
    try {
      const state = blockDragSourceKey.getState(this.view.state);
      const found = state?.decorationSet.find(
        undefined,
        undefined,
        (spec: { futoDragSource?: boolean }) => spec.futoDragSource === true,
      );
      if (found?.length === 1 && state?.dropTarget !== undefined) {
        landing.curtain.holdScrollThroughDrop();
        committed = this.commit(
          { from: found[0].from, to: found[0].to },
          state.dropTarget,
          landing.beforeDispatch,
        );
      }
    } finally {
      landing.curtain.end();
      if (!committed) this.clearDecoration();
    }
  }

  /** The document changed while a drop was landing: it commits (mapped) or
   * is dropped, after the transaction that changed it has been applied. */
  docChanged(): void {
    if (this.landing) queueMicrotask(() => this.landed());
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
    // A landing drop goes with the editor, uncommitted.
    this.landing?.curtain.end();
    this.landing = null;
    landingDrops.delete(this.view.dom);
    endInteraction('block-drag');
  }

  private reset(): void {
    this.lifted = null;
    this.indicatorPos = null;
  }
}
