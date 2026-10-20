/*
 * The live-reflow preview of a block drag: instead of a drop line, the other
 * blocks slide out of the way while you drag, so the note already looks the
 * way it will after the drop, and the dimmed source block sits in its landing
 * slot. A drag only ever lifts a top-level block; `measure` returns null for
 * any doc shape it cannot clone by index, and `blockDragSession.ts` falls back
 * to the drop line, as it does if the doc changes shape mid-drag (`sync`
 * returns false).
 *
 * The real document is never touched while dragging. Any style change on an
 * element inside the editor's scroll box costs Chromium a walk of the whole
 * note: on a 3,000-block note on a budget Android phone, 30-60ms a frame for
 * the transform of a dozen blocks, however few, with or without a transition
 * (measured 2026-10-07, block-drag-bench --device android). So the preview is
 * drawn on a "curtain": an opaque layer OUTSIDE the scroll box, over the
 * editor's visible area, holding clones of the blocks near the viewport. The
 * clones are shuffled with transforms, the curtain follows the scroll with one
 * transform of its own, and the real blocks underneath stay exactly as they
 * were.
 *
 * The geometry is cached for the drag, and the document staying the same does
 * not keep it right: an image that loads, a web font that swaps in or a
 * resized viewport changes the blocks' sizes under the drag. A ResizeObserver
 * on the blocks the curtain has cloned notices (`watch`), as does a check of
 * the window's place as the note scrolls (`followScroll`), and the preview is
 * measured and drawn again from the layout as it is then (`remeasure`).
 *
 * The session's whole contact with this module: `measure` (reads), `mount`
 * (first writes), `sync`/`target` per pointer step, `holdScrollThroughDrop` on
 * a committing release, `end`.
 */
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { LAND_CAP_MS, landCapOff, reflowForcedOff } from './blockDragCurtainConfig';
import { holdScrollExtent } from './blockDragCurtainDom';
import type { Reflow } from './blockDragCurtainTypes';
import { CurtainWindow } from './blockDragCurtainWindow';
import type { DropTarget } from './blockDragGeometry';

export { CURTAIN_STYLES, LAND_CAP_MS } from './blockDragCurtainConfig';

/** The reflow preview of one drag. */
export class ReflowCurtain extends CurtainWindow {
  private constructor(
    view: ProseView,
    host: HTMLElement,
    onBoundaryChange: (() => void) | undefined,
  ) {
    super(view, host, onBoundaryChange);
  }

  /** Sets up the preview for the drag of `source`, or returns null when it
   * cannot be previewed (see the file header, or the test switch). Reads only.
   * `host` is the element the curtain is appended to; `onBoundaryChange` is
   * the session's haptic tick. */
  static measure(
    view: ProseView,
    host: HTMLElement,
    source: { from: number },
    onBoundaryChange?: () => void,
  ): ReflowCurtain | null {
    const win = view.dom.ownerDocument.defaultView ?? window;
    if (reflowForcedOff(win)) return null;
    const curtain = new ReflowCurtain(view, host, onBoundaryChange);
    curtain.reflow = curtain.measureReflow(source);
    return curtain.reflow ? curtain : null;
  }

  /** The lift's first writes: the empty clip and curtain go in place, and the
   * curtain opens in idle time (or at the first gap change). */
  mount(): void {
    if (!this.reflow) return;
    this.placeCurtain(this.reflow);
    this.host.appendChild(this.reflow.clip);
    this.scheduleIdleOpen(this.reflow);
    const { scroller } = this.reflow;
    this.watch(this.reflow, scroller instanceof HTMLElement ? scroller : this.doc.documentElement);
  }

  /** The drop target under `clientY` for a release or a boundary check, or
   * null once the preview is no longer valid (`ensureValid`). */
  target(clientY: number): DropTarget | null {
    if (!this.ensureValid()) return null;
    const gap = this.reflowGapAt(clientY);
    const doc = this.view.state.doc;
    let pos = doc.content.size;
    doc.forEach((_node, offset, index) => {
      if (index === gap) pos = offset;
    });
    // `dom`/`indicator` are only read by the line, which reflow never draws.
    return { pos, dom: this.view.dom, indicator: { top: 0, left: 0, width: 0 } };
  }

  /** The drop target for a release at `clientY`, or null once the preview is
   * no longer valid. Unlike `target`, it first makes sure the measurements
   * still describe the layout — a size can change in the very task that
   * releases, before the ResizeObserver has reported it — and moves the
   * preview to the gap it resolves, so the committed move,
   * `holdScrollThroughDrop` and the picture `land` leaves up all agree on one
   * gap. Checked: the drawn window's first and last blocks and the note's last
   * two (`dropShrink`). A size change above any of them moves it, and one
   * inside the window moves its last block. */
  release(clientY: number): DropTarget | null {
    if (!this.ensureValid()) return null;
    const reflow = this.reflow!;
    reflow.pointerY = clientY;
    const read = [...this.cloneEdges(reflow), reflow.count - 1, reflow.count - 2];
    if (!this.layoutMatches(reflow, read)) this.remeasure(reflow);
    if (!this.sync(clientY, false)) return null;
    return this.target(clientY);
  }

  /** The pointer is at `clientY` (or auto-scroll moved the document under it):
   * moves the previewed gap there, ticking `onBoundaryChange` when `tick`.
   * Returns false when the preview ended itself because the doc changed shape
   * under the drag; the caller then falls back to the drop line. */
  sync(clientY: number, tick: boolean): boolean {
    if (!this.ensureValid()) return false;
    const reflow = this.reflow!;
    reflow.pointerY = clientY;
    const gap = this.reflowGapAt(clientY);
    const s = reflow.sourceIndex;
    const effective = gap === s || gap === s + 1 ? null : gap;
    if (effective === reflow.applied) return true;
    if (!reflow.open) {
      reflow.applied = effective;
      if (effective === null) return true;
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
      if (tick) this.onBoundaryChange?.();
      return true;
    }
    reflow.applied = effective;
    const plan = this.planCurtainWindow(reflow);
    this.applyShifts(reflow);
    this.applyCurtainWindow(reflow, plan);
    if (tick && effective !== null) this.onBoundaryChange?.();
    return true;
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
      reflow.sliding.add(clone.el);
    }
  }

  /** A release is about to commit the move this preview shows. The preview IS
   * the note after that move at the current scroll position, so the drop must
   * not scroll. Two things in the browser would scroll it:
   *
   * - Chromium's scroll anchoring pins the first visible block on screen
   *   across a layout change, and when the source sat above the viewport
   *   (auto-scroll carried it off the top) that block is one the move shifts
   *   up by the source's height, so the view jumped by it on release — only
   *   "sometimes", because it depends on which block the browser picked. The
   *   scroll position is put back after the move's layout, before its paint
   *   (a ResizeObserver's first report comes then). Turning anchoring off
   *   instead (`overflow-anchor: none` on the scroller for the drop) restyled
   *   the whole note twice, since the editor IS the scroller on the native
   *   shells: +280ms on the drop frame and a 300ms frame after it, on a
   *   3,000-block note on the budget phone (2026-10-09).
   * - A move can make the note shorter (`dropShrink`), and scrolled to near
   *   its bottom the browser clamps the scroll position to the shorter note,
   *   moving every block on screen down. The editor holds the missing extent
   *   until it is no longer needed (`holdScrollExtent`).
   *
   * Reads, then writes; the move's dispatch follows. */
  holdScrollThroughDrop(): void {
    const reflow = this.reflow;
    if (!reflow || reflow.applied === null) return;
    // A document changed under the landing drop (it commits mapped) is not
    // the one this geometry describes.
    if (this.view.state.doc !== reflow.doc) return;
    // Measured afresh: the layout may have changed since (`land` commits on
    // a size change).
    this.forget(reflow);
    const el =
      reflow.scroller instanceof HTMLElement
        ? reflow.scroller
        : (this.doc.scrollingElement as HTMLElement | null);
    if (!el) return;
    // The scroll extent after the move, and whether the browser would clamp
    // the scroll position to it; if so, how much it falls short.
    const after = el.scrollHeight - this.dropShrink(reflow);
    const clamps = el.scrollTop > Math.max(0, after - el.clientHeight) + 0.5;
    const short = clamps ? el.scrollTop + el.clientHeight - after : 0;
    const top = el.scrollTop;
    const restore = new ResizeObserver(() => {
      restore.disconnect();
      if (Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top;
    });
    restore.observe(el);
    if (short > 0) holdScrollExtent(this.view.dom, el, reflow.scroller, Math.ceil(short));
  }

  /** The release will commit this preview's move (`BlockDragSession.land`)
   * once the neighbours still sliding are in place, so nothing jumps: calls
   * `onLanded` when the last slide ends, or LAND_CAP_MS after the release
   * whatever the slides are doing; at once when nothing is sliding, under a
   * reduced-motion setting, or in a hidden page; and early at a scroll (the
   * picture does not follow one) or a size change of a watched block or the
   * scroll box. A size change is a relayout of everything on screen in
   * itself, so committing then is not seen as a jump: the clones' fixed
   * widths and heights would otherwise go on drawing the old line breaks until
   * the slide ended. The dropped block's clone undims and
   * snaps into its slot now. The curtain stays until `end`. */
  land(onLanded: () => void): void {
    const reflow = this.reflow;
    if (!reflow) {
      onLanded();
      return;
    }
    this.cancelIdleOpen(reflow);
    this.cancelIdle(reflow.idleFill);
    reflow.idleFill = 0;
    const source = reflow.clones.get(reflow.sourceIndex)?.el;
    if (source) {
      source.classList.remove('futo-mobile-dnd-reflow-source');
      source.style.transition = 'none';
      reflow.sliding.delete(source);
    }
    const win = this.doc.defaultView ?? window;
    if (
      !reflow.open ||
      reflow.sliding.size === 0 ||
      win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
      this.doc.visibilityState === 'hidden'
    ) {
      onLanded();
      return;
    }
    reflow.landed = () => {
      if (!reflow.landed) return;
      reflow.landed = null;
      reflow.onSlideEnd = null;
      win.clearTimeout(reflow.landTimer);
      onLanded();
    };
    reflow.onSlideEnd = () => {
      if (reflow.sliding.size === 0) reflow.landed?.();
    };
    if (!landCapOff(win)) reflow.landTimer = win.setTimeout(() => reflow.landed?.(), LAND_CAP_MS);
  }
}
