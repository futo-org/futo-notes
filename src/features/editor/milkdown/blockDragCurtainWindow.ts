import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { CurtainClones } from './blockDragCurtainClones';
import {
  CURTAIN_FILL_RESERVE_MS,
  CURTAIN_FILL_TIMEOUT_MS,
  CURTAIN_IDLE_OPEN_TIMEOUT_MS,
  REFLOW_WINDOW_DROP_VIEWPORTS,
  REFLOW_WINDOW_MARGIN_VIEWPORTS,
  REFLOW_WINDOW_URGENT_VIEWPORTS,
} from './blockDragCurtainConfig';
import { collapsedMargin } from './blockDragCurtainDom';
import { editorScrollContainer } from './blockDragGeometry';
import type { CurtainWindowPlan, Reflow } from './blockDragCurtainTypes';

/** The drawing half of the reflow preview: the curtain's window of clones,
 * the idle work and watchers that keep it current, and its lifecycle. */
export abstract class CurtainWindow extends CurtainClones {
  /** Sets up the preview for `source` — where the curtain goes; the blocks
   * themselves are measured as they are needed (`slotTop`) — or returns null
   * when this drag cannot be previewed (a block without rendered DOM, or a
   * source that is not top-level, which no gesture lifts). Reads only. */
  protected measureReflow(source: { from: number }): Reflow | null {
    const view = this.view;
    const doc = view.state.doc;
    if (doc.resolve(source.from).depth !== 0) return null;
    // Cloning by index needs the DOM children to be exactly the doc's blocks,
    // in order (a widget or a foreign node would shift every clone).
    if (view.dom.children.length !== doc.childCount) return null;
    // Each block's own view descriptor, not `view.nodeDOM(offset)`: nodeDOM
    // walks the blocks from the top on every call, which made this check
    // quadratic — 150-250ms on a 3,000-block note on a budget phone.
    // EQUAL, not identical: when a new document has an equal block where the
    // old one was, ProseMirror keeps that block's DOM and descriptor without
    // pointing the descriptor at the new node, so after the host's
    // `setContent` every untouched block failed an identity test and the drag
    // quietly fell back to the drop line. `eq` only walks a
    // block's content when the identity test has already failed.
    const blocks = view.dom.children;
    let sourceIndex = -1;
    let ok = true;
    doc.forEach((node, offset, index) => {
      const desc = (blocks[index] as { pmViewDesc?: { node?: ProseNode } } | undefined)?.pmViewDesc;
      if (!desc?.node || (desc.node !== node && !desc.node.eq(node))) ok = false;
      if (offset === source.from) sourceIndex = index;
    });
    if (!ok || sourceIndex < 0) return null;
    const count = doc.childCount;
    const unmeasured = () => new Float64Array(count).fill(NaN);
    const scroller = editorScrollContainer(this.view);
    const box = this.curtainBox(scroller);
    const clip = this.doc.createElement('div');
    clip.className = 'futo-mobile-dnd-reflow-clip';
    clip.setAttribute('aria-hidden', 'true');
    const curtain = this.doc.createElement('div');
    // `ProseMirror` so the editor's own content typography applies to the
    // clones; the curtain rules above override the editor's BOX rules.
    curtain.className = 'futo-mobile-dnd-reflow-curtain ProseMirror';
    clip.appendChild(curtain);
    const sliding = new Set<EventTarget>();
    const slideEnded = (event: Event) => {
      if (event.target === null || !sliding.delete(event.target)) return;
      reflow.onSlideEnd?.();
    };
    // Not `transitioncancel`: a slide sent somewhere new (the slot moved
    // mid-slide) cancels its old transition while still sliding.
    curtain.addEventListener('transitionend', slideEnded);
    const reflow: Reflow = {
      doc,
      count,
      tops: unmeasured(),
      lefts: unmeasured(),
      widths: unmeasured(),
      heights: unmeasured(),
      insets: unmeasured(),
      marginTops: unmeasured(),
      marginBottoms: unmeasured(),
      movedMarginTops: new Map(),
      shifts: null,
      originTop: this.reflowOriginTop(),
      originLeft: box.originLeft,
      sourceIndex,
      scroller,
      onScroll: () => this.onReflowScroll(),
      clip,
      curtain,
      box,
      open: false,
      idleOpen: 0,
      idleFill: 0,
      sizes: new ResizeObserver((entries) => this.onSizesChanged(reflow, entries)),
      watched: new Set(),
      unreported: new Set(),
      pointerY: Number.NaN,
      clones: new Map(),
      sliding,
      onSlideEnd: null,
      landed: null,
      landTimer: 0,
      applied: null,
      scrollFrame: 0,
    };
    return reflow;
  }

  /** Opens the curtain once the lift's frame is out (see `Reflow.open`). */
  protected scheduleIdleOpen(reflow: Reflow): void {
    reflow.idleOpen = this.whenIdle(() => {
      reflow.idleOpen = 0;
      if (this.reflow !== reflow || reflow.open) return;
      if (!this.ensureValid()) return;
      reflow.originTop = this.reflowOriginTop();
      this.openCurtain(reflow, this.planCurtainWindow(reflow));
    }, CURTAIN_IDLE_OPEN_TIMEOUT_MS);
  }

  /** Clones the rest of the window (out to REFLOW_WINDOW_MARGIN_VIEWPORTS) in
   * idle time, as many as each idle period has room for. */
  protected scheduleFill(reflow: Reflow): void {
    if (reflow.idleFill) return;
    reflow.idleFill = this.whenIdle((deadline) => {
      reflow.idleFill = 0;
      if (this.reflow !== reflow || !reflow.open) return;
      if (!this.ensureValid()) return;
      // Every block measured from here on is measured in the layout as it is
      // now, so the ones measured before must still be where they were: a
      // size change above the window (an image loading) that this idle slice
      // runs ahead of the scroll event reporting it would leave the clones
      // drawn with the old positions beside the new ones, and the scroll
      // follow, judging the layout by the window's first block, could be
      // looking at one of the new.
      if (!this.layoutMatches(reflow, this.cloneEdges(reflow))) {
        this.remeasure(reflow);
        return;
      }
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

  /** Draws the curtain over the editor with its first window of clones.
   * Writes only: `measureReflow` and `planCurtainWindow` did the reading. */
  protected openCurtain(reflow: Reflow, plan: CurtainWindowPlan): void {
    reflow.open = true;
    this.cancelIdleOpen(reflow);
    reflow.curtain.style.background = reflow.box.background;
    reflow.curtain.style.transform = `translateY(${reflow.originTop - reflow.box.clip.top}px)`;
    this.applyCurtainWindow(reflow, plan);
    reflow.scroller.addEventListener('scroll', reflow.onScroll, { passive: true });
  }

  /** Whether the preview is still up and describes the document as it is now.
   * A mismatch (the doc was replaced under the drag) ends the preview here, so
   * no read ever indexes DOM children the measurements no longer match. The
   * session then falls back to the drop line, or cancels a drop whose source
   * is gone. */
  ensureValid(): boolean {
    const reflow = this.reflow;
    if (!reflow) return false;
    if (this.view.state.doc === reflow.doc && this.view.dom.children.length === reflow.count) {
      return true;
    }
    this.end();
    return false;
  }

  /** Moves the curtain to the current scroll position and brings its window
   * of clones up to date. */
  protected followScroll(reflow: Reflow): void {
    reflow.originTop = this.reflowOriginTop();
    // A size change above the window moves the whole window without resizing
    // any block it watches, and scroll anchoring makes that a scroll: the
    // window's first block is where it was measured, or the preview is.
    // One rect read a frame: this runs on every frame of an auto-scroll.
    let first = Infinity;
    for (const i of reflow.clones.keys()) first = Math.min(first, i);
    if (
      first !== Infinity &&
      Math.abs(
        this.view.dom.children[first].getBoundingClientRect().top -
          reflow.originTop -
          reflow.tops[first],
      ) > 0.5
    ) {
      this.remeasure(reflow);
      return;
    }
    const plan = this.planCurtainWindow(reflow);
    reflow.curtain.style.transform = `translateY(${reflow.originTop - reflow.box.clip.top}px)`;
    this.applyCurtainWindow(reflow, plan);
  }

  /** Which clones to drop and which blocks to clone so the window covers the
   * blocks whose CURRENT (shifted) position is within `viewports` viewport
   * heights of the visible area (REFLOW_WINDOW_URGENT_VIEWPORTS). Reads only —
   * every slot the writes will need is measured here. */
  protected planCurtainWindow(
    reflow: Reflow,
    viewports = REFLOW_WINDOW_URGENT_VIEWPORTS,
  ): CurtainWindowPlan {
    const { clones, sourceIndex } = reflow;
    const viewport = window.innerHeight || this.doc.documentElement.clientHeight;
    const near = (i: number, within: number) => {
      const margin = viewport * within;
      const top = this.slotTop(i) + this.reflowShift(i, reflow.applied);
      return (
        top + reflow.heights[i] >= -reflow.originTop - margin &&
        top <= viewport - reflow.originTop + margin
      );
    };
    const remove = [...clones.keys()].filter((i) => !near(i, REFLOW_WINDOW_DROP_VIEWPORTS));
    const add: number[] = [];
    const missing = (within: number) => {
      const margin = viewport * within;
      const visTop = -reflow.originTop - margin;
      const visBottom = viewport - reflow.originTop + margin;
      // Every block but the source moves by one of two shifts (`moveShifts`),
      // so the window's blocks are the ones within the larger of them of it,
      // found by a binary search — plus the source, wherever it lands.
      const shifts = reflow.applied === null ? null : this.moveShifts(reflow.applied);
      const reach = shifts ? Math.max(Math.abs(shifts.between), Math.abs(shifts.after)) : 0;
      const first = this.firstNotPast((i) => this.slotTop(i) + reflow.heights[i] + reach < visTop);
      const out: number[] = [];
      for (let i = first; i < reflow.count && this.slotTop(i) - reach <= visBottom; i += 1) {
        if (i !== sourceIndex && !clones.has(i) && near(i, within)) out.push(i);
      }
      if (!clones.has(sourceIndex) && near(sourceIndex, within)) out.push(sourceIndex);
      return out;
    };
    add.push(...missing(viewports));
    // Everything the writes will read: the shifts (the margins and slots
    // around both ends of the move), and the new clones' slots and insets.
    for (const i of add) {
      this.reflowShift(i, reflow.applied);
      if (Number.isNaN(reflow.insets[i])) {
        reflow.insets[i] = collapsedMargin(this.view.dom.children[i] as HTMLElement, 'top');
      }
    }
    return { remove, add };
  }

  /** Writes a `planCurtainWindow` result: new clones go in already at their
   * target shift, so they never animate in. */
  protected applyCurtainWindow(reflow: Reflow, plan: CurtainWindowPlan): void {
    for (const i of plan.remove) {
      reflow.clones.get(i)?.el.remove();
      reflow.clones.delete(i);
      this.unwatch(reflow, this.view.dom.children[i]);
    }
    for (const i of plan.add) this.addClone(reflow, i);
    this.scheduleFill(reflow);
  }

  /** A watched size changed: the preview is measured again. A first report
   * is the size the element was measured at, not a change. Runs between
   * layout and paint, so the reads are cheap and the new preview is painted
   * in the same frame as the change. */
  protected onSizesChanged(reflow: Reflow, entries: ResizeObserverEntry[]): void {
    if (this.reflow !== reflow) return;
    if (reflow.landed) {
      // A layout change while the move waits on its slides: it commits now.
      if (entries.some((entry) => !reflow.unreported.delete(entry.target))) reflow.landed();
      return;
    }
    if (!this.ensureValid()) return;
    let changed = false;
    for (const entry of entries) {
      if (!reflow.unreported.delete(entry.target)) changed = true;
    }
    if (changed) this.remeasure(reflow);
  }

  /** The layout changed under the drag: every cached measurement is dropped,
   * the slot under the pointer is found again against the new layout, and the
   * curtain is redrawn with fresh clones — at their shifts, without a slide,
   * since nothing moved but the layout itself. */
  protected remeasure(reflow: Reflow): void {
    // Reads.
    this.forget(reflow);
    const { box } = reflow;
    // A closed curtain previews nothing yet (`sync` opens it at the first
    // slot), so only an open one has a slot to find again.
    if (reflow.open && !Number.isNaN(reflow.pointerY)) {
      const gap = this.reflowGapAt(reflow.pointerY);
      const s = reflow.sourceIndex;
      reflow.applied = gap === s || gap === s + 1 ? null : gap;
    }
    const stale = reflow.clones;
    reflow.clones = new Map();
    const plan = reflow.open ? this.planCurtainWindow(reflow) : null;
    // Where each clone is drawn right now, mid-slide or not: its replacement
    // starts there, so a remeasure never makes a block jump.
    const drawnTops = new Map<number, number>();
    for (const [i, clone] of stale) drawnTops.set(i, clone.el.getBoundingClientRect().top);
    // Writes.
    this.placeCurtain(reflow);
    for (const [i, clone] of stale) {
      clone.el.remove();
      if (!plan?.add.includes(i)) this.unwatch(reflow, this.view.dom.children[i]);
    }
    reflow.sliding.clear();
    if (!plan) return;
    reflow.curtain.style.background = box.background;
    reflow.curtain.style.transform = `translateY(${reflow.originTop - box.clip.top}px)`;
    this.applyCurtainWindow(reflow, plan);
    const glides: Array<{ el: HTMLElement; shift: number }> = [];
    for (const [i, top] of drawnTops) {
      const clone = reflow.clones.get(i);
      if (!clone) continue;
      // The clone's box top on screen with no shift (`addClone`).
      const from = top - (reflow.originTop + this.slotTop(i) - reflow.insets[i]);
      if (Math.abs(from - clone.shift) <= 0.5) continue;
      clone.el.style.transform = `translateY(${from}px)`;
      glides.push(clone);
    }
    if (glides.length === 0) return;
    // One style pass resolves every starting point, then each slides on.
    void getComputedStyle(glides[0].el).transform;
    for (const clone of glides) {
      clone.el.style.transform = `translateY(${clone.shift}px)`;
      reflow.sliding.add(clone.el);
    }
  }

  protected onReflowScroll(): void {
    const reflow = this.reflow;
    // The picture does not follow a scroll once released: the move commits.
    if (reflow?.landed) {
      reflow.landed();
      return;
    }
    if (!reflow || reflow.scrollFrame) return;
    reflow.scrollFrame = requestAnimationFrame(() => {
      reflow.scrollFrame = 0;
      if (this.reflow === reflow && reflow.open && this.ensureValid()) this.followScroll(reflow);
    });
  }

  /** Takes the curtain down and ends the preview. Every exit but a committed
   * move calls it, in the same synchronous step as the exit, so no stale
   * preview is painted over the result. */
  end(): void {
    const reflow = this.reflow;
    if (!reflow) return;
    this.stop(reflow);
    reflow.clip.remove();
  }

  /** Stops everything that keeps the preview live (idle work, the size
   * watch, the scroll follow) and lets go of it. */
  protected stop(reflow: Reflow): void {
    this.cancelIdleOpen(reflow);
    this.cancelIdle(reflow.idleFill);
    reflow.sizes.disconnect();
    reflow.landed = null;
    reflow.onSlideEnd = null;
    (this.doc.defaultView ?? window).clearTimeout(reflow.landTimer);
    cancelAnimationFrame(reflow.scrollFrame);
    reflow.scroller.removeEventListener('scroll', reflow.onScroll);
    this.reflow = null;
  }
}
