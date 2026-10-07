/*
 * The live-reflow preview of a block drag: instead of a drop line, the other
 * blocks slide out of the way while you drag, so the note already looks the
 * way it will after the drop, and the dimmed source block sits in its landing
 * slot. Only for top-level blocks; `measure` returns null for a list item (and
 * for any doc shape it cannot clone by index), and `blockDragSession.ts` falls
 * back to the drop line, as it does if the doc changes shape mid-drag (`sync`
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
 * The session's whole contact with this module: `measure` (reads), `mount`
 * (first writes), `sync`/`target` per pointer step, `end`.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { DropTarget } from './blockDragGeometry';

/**
 * TEST/BENCH-ONLY switch, read when a drag starts: `?blockDragReflow=off` in
 * the page URL, or `window.__futoBlockDragReflow = 'off'` set before the drag
 * (the block-drag bench injects it for its `:line` variants), forces the drop
 * line for top-level blocks too. Never set by production hosts.
 */
function reflowForcedOff(win: Window): boolean {
  try {
    if ((win as Window & { __futoBlockDragReflow?: string }).__futoBlockDragReflow === 'off') {
      return true;
    }
    return new URLSearchParams(win.location.search).get('blockDragReflow') === 'off';
  } catch {
    return false;
  }
}

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
  /** The document the geometry below was measured against. Any transaction
   * that changes the doc (a host `setContent`, a sync adopt, an undo) makes
   * every cached slot and clone stale, whatever the block count is. */
  doc: ProseNode;
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

/** The curtain's rules, spliced into the session's one-time stylesheet. */
export const CURTAIN_STYLES = `
    /* Live reflow (\`ReflowCurtain\`): the clip sits over the scroll box's visible
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
  `;

/** The reflow preview of one drag. */
export class ReflowCurtain {
  private reflow: Reflow | null = null;

  private constructor(
    private readonly view: ProseView,
    private readonly host: HTMLElement,
    private readonly onBoundaryChange: (() => void) | undefined,
  ) {}

  private get doc(): Document {
    return this.view.dom.ownerDocument;
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
    this.scheduleIdleOpen(this.reflow);
  }

  /** Sets up the preview for `source` — where the curtain goes; the blocks
   * themselves are measured as they are needed (`slotTop`) — or returns null
   * when this drag cannot be previewed (a list item, or a block without
   * rendered DOM). Reads only. */
  private measureReflow(source: { from: number }): Reflow | null {
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
      doc,
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
      if (!this.ensureValid()) return;
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
      if (!this.ensureValid()) return;
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
    this.host.appendChild(clip);
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
    // The flip is at each block's own visual midpoint (not its slot's, which
    // includes the gap below): the lower half of a block is "after it".
    return this.firstNotPast((i) => this.slotTop(i) + reflow.heights[i] / 2 < contentY);
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

  /** The pointer is at `clientY` (or auto-scroll moved the document under it):
   * moves the previewed gap there, ticking `onBoundaryChange` when `tick`.
   * Returns false when the preview ended itself because the doc changed shape
   * under the drag; the caller then falls back to the drop line. */
  sync(clientY: number, tick: boolean): boolean {
    if (!this.ensureValid()) return false;
    const reflow = this.reflow!;
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
      if (this.reflow === reflow && reflow.open && this.ensureValid()) this.followScroll(reflow);
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
  end(): void {
    const reflow = this.reflow;
    if (!reflow) return;
    this.cancelIdleOpen(reflow);
    this.cancelIdle(reflow.idleFill);
    cancelAnimationFrame(reflow.scrollFrame);
    reflow.scroller.removeEventListener('scroll', reflow.onScroll);
    reflow.clip.remove();
    this.reflow = null;
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

/** What the editor's text is drawn on, so the curtain hides the real blocks
 * without a seam: the first opaque-ish background at or above `el`, else the
 * embed's `--futo-editor-surface` (the native hosts paint their own colour
 * behind a transparent page; editor.html), else the colour scheme's paper. */
function backgroundBehind(el: HTMLElement): string {
  const win = el.ownerDocument.defaultView ?? window;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const color = win.getComputedStyle(n).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  const root = el.ownerDocument.documentElement;
  const surface = win.getComputedStyle(root).getPropertyValue('--futo-editor-surface').trim();
  if (surface) return surface;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : win.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return dark ? '#1a1a1a' : '#fcfcfc';
}
