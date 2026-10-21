import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { CurtainBox, MoveShifts, Reflow } from './blockDragCurtainTypes';
import { backgroundBehind, collapse, collapsedMargin, visibleBox } from './blockDragCurtainDom';

/** The measuring half of the reflow preview: where each block sits, how the
 * margins between blocks collapse, and how far a previewed move shifts them. */
export abstract class CurtainLayout {
  protected reflow: Reflow | null = null;

  protected constructor(
    protected readonly view: ProseView,
    protected readonly host: HTMLElement,
    protected readonly onBoundaryChange: (() => void) | undefined,
  ) {}

  protected get doc(): Document {
    return this.view.dom.ownerDocument;
  }

  /** Where the clip and curtain go over `scroller` as the page is laid out
   * now, and (unless `paint` is false, for a check of the geometry alone) what
   * the curtain is painted with. Reads only. */
  protected curtainBox(
    scroller: HTMLElement | Window,
    paint = true,
  ): CurtainBox & { originLeft: number } {
    const win = this.doc.defaultView ?? window;
    const visible =
      scroller instanceof HTMLElement
        ? visibleBox(scroller)
        : { top: 0, left: 0, width: win.innerWidth, height: win.innerHeight };
    const viewRect = this.view.dom.getBoundingClientRect();
    return {
      clip: visible,
      left: viewRect.left - visible.left,
      width: viewRect.width,
      height: Math.max(this.view.dom.scrollHeight, viewRect.height),
      background: paint ? backgroundBehind(this.view.dom) : '',
      originLeft: viewRect.left,
    };
  }

  /** The scroll-content origin in client coordinates: a slot's `top` plus this
   * is where it sits on screen right now. */
  protected reflowOriginTop(): number {
    const scroller = this.view.dom;
    return scroller.getBoundingClientRect().top - scroller.scrollTop;
  }

  /** Block `i`'s top in scroll-content coordinates. */
  protected slotTop(i: number): number {
    const reflow = this.reflow!;
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

  /** Block `i`'s bottom edge in scroll-content coordinates; `-1` is the top
   * of the editor's content box, the edge the first block's margin is
   * measured from. */
  protected slotBottom(i: number): number {
    if (i < 0) return this.slotTop(0) - this.marginAbove(0, true);
    return this.slotTop(i) + this.reflow!.heights[i];
  }

  /** The margin block `i` keeps above itself as the note's first block
   * (`first`) or after another one: its own, collapsed with any of its first
   * descendants' that reach out through its top. The editor zeroes a
   * paragraph's top margin when it is the first block (milkdownEditor.css's
   * `:first-child` rule) but not a heading's, so a block's margin in the
   * position it is NOT in now is read off a detached copy (`ownMarginTop`). */
  protected marginAbove(i: number, first: boolean): number {
    const reflow = this.reflow!;
    const el = this.view.dom.children[i] as HTMLElement;
    if (Number.isNaN(reflow.insets[i])) reflow.insets[i] = collapsedMargin(el, 'top');
    let own: number;
    if (first === (i === 0)) {
      if (Number.isNaN(reflow.marginTops[i])) {
        reflow.marginTops[i] = parseFloat(getComputedStyle(el).marginTop) || 0;
      }
      own = reflow.marginTops[i];
    } else {
      own = reflow.movedMarginTops.get(i) ?? this.ownMarginTop(el, first);
      reflow.movedMarginTops.set(i, own);
    }
    return collapse(own, reflow.insets[i]);
  }

  /** Block `i`'s bottom margin, with its last descendants' that reach out
   * through its bottom. Nothing in the editor's stylesheet makes it depend on
   * where the block is. */
  protected marginBelow(i: number): number {
    const reflow = this.reflow!;
    if (Number.isNaN(reflow.marginBottoms[i])) {
      const el = this.view.dom.children[i] as HTMLElement;
      reflow.marginBottoms[i] = collapse(
        parseFloat(getComputedStyle(el).marginBottom) || 0,
        collapsedMargin(el, 'bottom'),
      );
    }
    return reflow.marginBottoms[i];
  }

  /** The space between block `a`'s bottom and block `b`'s top when `b`
   * follows `a` (`a === -1`: `b` is the first block), as the browser lays it
   * out: the two margins collapse into one. */
  protected spaceBetween(a: number, b: number): number {
    if (a < 0) return this.marginAbove(b, true);
    return collapse(this.marginBelow(a), this.marginAbove(b, false));
  }

  /** `el`'s own top margin as the first block (`first`) or after another one,
   * read off a shallow copy in a detached, undisplayed editor box so only the
   * stylesheet decides it. Needed at most twice a drag: only a move to or
   * from the top of the note changes which block is first. */
  protected ownMarginTop(el: HTMLElement, first: boolean): number {
    const probe = this.doc.createElement('div');
    probe.className = 'ProseMirror';
    probe.style.display = 'none';
    if (!first) probe.appendChild(this.doc.createElement('p'));
    const copy = el.cloneNode(false) as HTMLElement;
    probe.appendChild(copy);
    // Beside the editor, so the copy inherits the same font size its `em`
    // margins resolve against.
    (this.view.dom.parentElement ?? this.host).appendChild(probe);
    const margin = parseFloat(getComputedStyle(copy).marginTop) || 0;
    probe.remove();
    return margin;
  }

  /** The first block index in [0, count] for which `past(i)` is false, for a
   * `past` that is true up to some index and false after it. */
  protected firstNotPast(past: (i: number) => boolean): number {
    let lo = 0;
    let hi = this.reflow!.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (past(mid)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The gap index (0..n) under `clientY`, judged against the blocks where the
   * preview DRAWS them: starting from the slot open now, the slot moves below
   * the block under it once the pointer passes that block's drawn midpoint (its
   * own, not its slot's, which includes the gap below), and above the block
   * over it likewise. Judging against the lift-time layout instead put the flip
   * back up a whole source-height inside the drawn slot, which is worst for a
   * long paragraph. It cannot flip back and forth: passing a block moves that
   * block to the other side of the slot, away from the pointer by the room the
   * source takes. Auto-scroll re-syncs it as the document moves under a still
   * pointer, a block at a time. */
  protected reflowGapAt(clientY: number): number {
    const reflow = this.reflow!;
    const scroller = this.view.dom;
    const rect = scroller.getBoundingClientRect();
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    reflow.originTop = rect.top - scroller.scrollTop;
    const contentY = y - reflow.originTop;
    const s = reflow.sourceIndex;
    const drawnMid = (i: number, gap: number) =>
      this.slotTop(i) + this.reflowShift(i, gap) + reflow.heights[i] / 2;
    // Gaps s and s + 1 are both the source's own place: the block under the
    // slot is s + 1 and the one over it s - 1.
    let gap = reflow.applied ?? s;
    const start = gap;
    for (;;) {
      const below = gap === s ? s + 1 : gap;
      if (below >= reflow.count || drawnMid(below, gap) >= contentY) break;
      gap = below + 1;
    }
    if (gap !== start) return gap;
    for (;;) {
      const above = gap === s + 1 ? s - 1 : gap - 1;
      if (above < 0 || drawnMid(above, gap) <= contentY) break;
      gap = above;
    }
    return gap;
  }

  /** How far block `i` sits from its natural place with `gap` previewed: the
   * blocks between the source and `gap` shift by the room the source takes,
   * the source slides to its landing slot, and the blocks past both shift by
   * whatever the margins around the two ends change by (`moveShifts`). */
  protected reflowShift(i: number, gap: number | null): number {
    const { sourceIndex: s } = this.reflow!;
    if (gap === null || gap === s || gap === s + 1) return 0;
    const shifts = this.moveShifts(gap);
    if (i === s) return shifts.source;
    if (gap > s) {
      if (i > s && i < gap) return shifts.between;
      return i >= gap ? shifts.after : 0;
    }
    if (i >= gap && i < s) return shifts.between;
    return i > s ? shifts.after : 0;
  }

  /** The shifts for moving the source to `gap`, worked out from the blocks'
   * heights and margins exactly as the browser will lay the note out after the
   * drop. Every gap between two blocks is their two margins collapsed into
   * one, so the space the source leaves behind (or opens up) is not simply its
   * height plus the gap below it: next to a heading, or at the top of the note
   * (`marginAbove`), the margins on either side differ, and a preview built on
   * that assumption moved the other blocks on release. */
  protected moveShifts(gap: number): MoveShifts {
    const reflow = this.reflow!;
    if (reflow.shifts?.gap === gap) return reflow.shifts.value;
    const s = reflow.sourceIndex;
    const height = (i: number) => this.slotBottom(i) - this.slotTop(i);
    const space = (a: number, b: number) => this.spaceBetween(a, b);
    let value: MoveShifts;
    if (gap > s) {
      // Down: what follows the source closes up over it, and it opens a place
      // for itself between gap - 1 and gap.
      const closed = space(s - 1, s) + height(s) + space(s, s + 1) - space(s - 1, s + 1);
      const landed = this.slotBottom(gap - 1) - closed + space(gap - 1, s);
      const opened =
        gap < reflow.count
          ? space(gap - 1, s) + height(s) + space(s, gap) - space(gap - 1, gap)
          : 0;
      value = { between: -closed, source: landed - this.slotTop(s), after: opened - closed };
    } else {
      // Up: the source opens a place for itself between gap - 1 and gap, and
      // what followed it closes up over where it was.
      const opened = space(gap - 1, s) + height(s) + space(s, gap) - space(gap - 1, gap);
      const landed = this.slotBottom(gap - 1) + space(gap - 1, s);
      const closed =
        s + 1 < reflow.count
          ? space(s - 1, s) + height(s) + space(s, s + 1) - space(s - 1, s + 1)
          : 0;
      value = { between: opened, source: landed - this.slotTop(s), after: opened - closed };
    }
    reflow.shifts = { gap, value };
    return value;
  }

  /** The first and last block the drawn window clones (none when it has none). */
  protected cloneEdges(reflow: Reflow): number[] {
    let first = Infinity;
    let last = -1;
    for (const i of reflow.clones.keys()) {
      first = Math.min(first, i);
      last = Math.max(last, i);
    }
    return Number.isFinite(first) ? [first, last] : [];
  }

  /** Whether the blocks `only` (those of them measured), and the curtain's
   * box, are still where they were measured. A block that changed size moves
   * every block after it, so checking a block also catches any changing
   * above it. Reads only. */
  protected layoutMatches(reflow: Reflow, only: number[]): boolean {
    const moved = (a: number, b: number) => Math.abs(a - b) > 0.5;
    const box = this.curtainBox(reflow.scroller, false);
    if (
      moved(box.clip.top, reflow.box.clip.top) ||
      moved(box.clip.left, reflow.box.clip.left) ||
      moved(box.clip.width, reflow.box.clip.width) ||
      moved(box.clip.height, reflow.box.clip.height) ||
      moved(box.width, reflow.box.width) ||
      moved(box.height, reflow.box.height)
    ) {
      return false;
    }
    const originTop = this.reflowOriginTop();
    const blocks = this.view.dom.children;
    for (const i of only) {
      if (i < 0 || Number.isNaN(reflow.tops[i])) continue;
      const rect = blocks[i].getBoundingClientRect();
      if (
        moved(rect.top - originTop, reflow.tops[i]) ||
        moved(rect.height, reflow.heights[i]) ||
        moved(rect.left - box.originLeft, reflow.lefts[i]) ||
        moved(rect.width, reflow.widths[i])
      ) {
        return false;
      }
    }
    return true;
  }

  /** Drops every cached measurement, and reads the curtain's box and the
   * scroll origin afresh. */
  protected forget(reflow: Reflow): void {
    for (const cache of [
      reflow.tops,
      reflow.lefts,
      reflow.widths,
      reflow.heights,
      reflow.insets,
      reflow.marginTops,
      reflow.marginBottoms,
    ]) {
      cache.fill(Number.NaN);
    }
    reflow.movedMarginTops.clear();
    reflow.shifts = null;
    const box = this.curtainBox(reflow.scroller);
    reflow.box = box;
    reflow.originLeft = box.originLeft;
    reflow.originTop = this.reflowOriginTop();
  }

  /** How much shorter the previewed move makes the note: how far the end of
   * its last block moves up. Counted with and without the last block's bottom
   * margin, whichever is more, so a move that changes which block is last
   * never falls short whether or not the browser counts that margin in the
   * scroll extent (too much only leaves a few pixels of padding for a while). */
  protected dropShrink(reflow: Reflow): number {
    const gap = reflow.applied!;
    const s = reflow.sourceIndex;
    const last = reflow.count - 1;
    const newLast = gap === reflow.count ? s : s === last ? last - 1 : last;
    if (newLast < 0) return 0;
    const byBlock =
      this.slotBottom(last) - (this.slotBottom(newLast) + this.reflowShift(newLast, gap));
    return Math.max(byBlock, byBlock + this.marginBelow(last) - this.marginBelow(newLast));
  }
}
