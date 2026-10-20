import type { Node as ProseNode } from '@milkdown/kit/prose/model';

export interface Reflow {
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
  /** How far up each clone is drawn from its block's top: the margin its
   * first descendants reach out through its top with (`collapsedMargin`).
   * NaN until read. */
  insets: Float64Array;
  /** Each block's own top margin where it is now, and its bottom margin with
   * its last descendants' (`marginBelow`). NaN until read. */
  marginTops: Float64Array;
  marginBottoms: Float64Array;
  /** A block's own top margin at the other end of the note's first-block
   * rule: block 0's after another block, any other block's as the first. */
  movedMarginTops: Map<number, number>;
  /** `moveShifts` of the gap it was last worked out for. */
  shifts: { gap: number; value: MoveShifts } | null;
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
  /** Watches the sizes of the cloned blocks and the scroll box (`watch`). */
  sizes: ResizeObserver;
  /** What `sizes` watches, and of that, what it has not yet reported once
   * (its first report is the size it was measured at, not a change). */
  watched: Set<Element>;
  unreported: Set<Element>;
  /** The pointer's y at the last `sync`, which a `remeasure` re-resolves the
   * slot against. NaN before the first. */
  pointerY: number;
  /** Live clones by block index, with the shift (px) written on each. */
  clones: Map<number, { el: HTMLElement; shift: number }>;
  /** The clones whose slide (a transform transition) is still running. */
  sliding: Set<EventTarget>;
  /** Called as each slide ends, once `land` is waiting on them. */
  onSlideEnd: (() => void) | null;
  /** While the release's move waits for the slides (`land`): what commits it,
   * and the LAND_CAP_MS timer. */
  landed: (() => void) | null;
  landTimer: number;
  /** The gap index currently previewed, or null for "nothing moved". */
  applied: number | null;
  scrollFrame: number;
}

/** Where `placeCurtain` puts the clip (client coordinates) and the curtain
 * (relative to the clip), and what the curtain is painted with. */
export interface CurtainBox {
  clip: { top: number; left: number; width: number; height: number };
  left: number;
  width: number;
  height: number;
  background: string;
}

/** How far a previewed move shifts the blocks, by where they sit relative to
 * it: the ones between the source and the gap, the source itself, and every
 * one after both. The last is zero unless the blocks around the two ends have
 * different margins (a heading's top margin is bigger than a paragraph's). */
export interface MoveShifts {
  between: number;
  source: number;
  after: number;
}

export interface CurtainWindowPlan {
  remove: number[];
  add: number[];
}
