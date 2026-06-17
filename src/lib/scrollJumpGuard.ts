import { ViewPlugin } from '@codemirror/view';
import type { EditorView, PluginValue, ViewUpdate } from '@codemirror/view';

/**
 * Suppress CodeMirror's mid-scroll scroll-anchor corrections that show up as a
 * visible "jump" on a mobile touch-momentum scroller.
 *
 * Why this exists
 * ---------------
 * CM6 sizes off-screen lines from an ESTIMATE (`HeightMapGap`). For long lines
 * that wrap in a PROPORTIONAL font, the estimate can be ~200px off. When such a
 * line scrolls into the measured range, CM6 measures its real height, the height
 * map changes, and CM6 writes `scrollDOM.scrollTop += diff` to keep its scroll
 * anchor pinned (DocView measure cycle, `scroll.scrollTop += diff`). On a desktop
 * wheel scroller that reposition is invisible, but on an iOS/Android native
 * touch-momentum scroller it lands as a large backward jolt — the note "jumps
 * around" while you scroll. There is no CM6 facet to disable the anchor
 * correction, and the height estimate can't be made accurate for proportional
 * wrapping (CM6 also re-creates the gap once the line scrolls far away again).
 *
 * What this does
 * --------------
 * While the user is actively scrolling, watch the scroller and revert any
 * single-frame reversal LARGER than {@link THRESHOLD_PX} against the current
 * scroll direction. A genuine touch/momentum scroll cannot reverse that far in
 * one ~16ms frame (that would be >1500px/s of reversal, and `overscroll-behavior`
 * is disabled so there is no bounce), so a jump that big is necessarily a CM6
 * correction injected mid-scroll. We keep the scroller where the user's gesture
 * put it; CM6's height map is still updated, so only the jarring reposition is
 * dropped (the correction is a one-shot per measurement, so it does not re-fire
 * into a fight).
 *
 * Mobile-only: on desktop CM6 scrolls inside an external container with the
 * app's own scroll compensation (MarkdownEditor `scrollParent`), so this guard
 * is not wired in there. See docs/learnings/hr-scroll-jank.md.
 */
const THRESHOLD_PX = 30;
/** Treat the user as "actively scrolling" within this window of a scroll event. */
const ACTIVE_WINDOW_MS = 250;

/**
 * Decide whether a single-frame scroll delta is a CM6 anchor correction to
 * revert (vs. a genuine user/momentum scroll frame). Pure for testability.
 *
 * @param delta      scrollTop change this frame (px)
 * @param dir        established recent scroll direction (+1 down, -1 up, 0 none)
 * @param msSinceScroll  ms since the last real `scroll` event
 */
export function isInjectedReversal(
  delta: number,
  dir: number,
  msSinceScroll: number,
  thresholdPx: number = THRESHOLD_PX,
  activeWindowMs: number = ACTIVE_WINDOW_MS,
): boolean {
  if (dir === 0) return false; // no established direction yet
  if (msSinceScroll >= activeWindowMs) return false; // not actively scrolling
  const nd = delta > 0 ? 1 : -1;
  return nd !== dir && Math.abs(delta) > thresholdPx;
}

export const scrollJumpGuard = ViewPlugin.fromClass(
  class implements PluginValue {
    private readonly scroller: HTMLElement;
    private readonly onScroll: () => void;
    private raf = 0;
    private looping = false;
    private last = 0;
    private dir = 0;
    private lastScrollMs = 0;

    constructor(view: EditorView) {
      this.scroller = view.scrollDOM;
      this.last = this.scroller.scrollTop;
      this.onScroll = () => {
        this.lastScrollMs = this.now();
        if (!this.looping) {
          this.looping = true;
          this.raf = requestAnimationFrame(this.tick);
        }
      };
      this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    }

    // performance.now() guarded for non-browser test envs.
    private now(): number {
      return typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
    }

    private readonly tick = (): void => {
      const t = this.scroller.scrollTop;
      const d = t - this.last;
      if (Math.abs(d) > 0.5) {
        const nd = d > 0 ? 1 : -1;
        // Don't touch reversals at the scroll extremes: a momentum rubber-band
        // at the very top/bottom is a real reversal that looks like a CM
        // correction, and a cursor-reveal scrollIntoView near an edge also
        // lands here. Only suppress corrections in the interior of the doc.
        const maxTop = this.scroller.scrollHeight - this.scroller.clientHeight;
        const nearEdge = t <= 1 || t >= maxTop - 1;
        if (!nearEdge && isInjectedReversal(d, this.dir, this.now() - this.lastScrollMs)) {
          // CM6 injected a large reverse correction mid-scroll — undo it,
          // keeping the scroller where the gesture left it. Don't advance
          // last/dir: this frame is rejected.
          this.scroller.scrollTop = this.last;
          this.raf = requestAnimationFrame(this.tick);
          return;
        }
        this.dir = nd;
      }
      this.last = t;
      // Idle out once the user has stopped scrolling, so we're not running a
      // rAF loop forever.
      if (this.now() - this.lastScrollMs >= ACTIVE_WINDOW_MS) {
        this.looping = false;
        return;
      }
      this.raf = requestAnimationFrame(this.tick);
    };

    update(_update: ViewUpdate): void {
      // Keep our baseline in sync if the scroller moved without a scroll event
      // (e.g. programmatic scrollIntoView) while we're idle, so the next user
      // scroll measures deltas from the right place.
      if (!this.looping) this.last = this.scroller.scrollTop;
    }

    destroy(): void {
      this.looping = false;
      cancelAnimationFrame(this.raf);
      this.scroller.removeEventListener('scroll', this.onScroll);
    }
  },
);
