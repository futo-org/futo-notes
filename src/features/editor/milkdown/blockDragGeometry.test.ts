/**
 * Unit coverage for the shared drag mechanics in `blockDragGeometry.ts` — the
 * edge auto-scroll loop specifically.
 *
 * The regression this locks: the old helper stepped `scrollTop` by 14px ONCE
 * PER `pointermove`, so a finger parked in the edge zone (the only gesture that
 * can reach an off-screen boundary without lifting) produced no events and
 * therefore no scrolling at all. A device pass on a 250-block note held the
 * bottom edge for 20-25 seconds and the note never moved.
 *
 * The frame clock and the scroller are both stubs on purpose: this asserts the
 * loop's arithmetic and lifecycle (rate, ramp, clamping at the ends, and that
 * it stops), which is exactly what is unreadable from a browser run. The real
 * touch stream through the real editor is
 * `tests/editor-embed-milkdown.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { createDragAutoScroller } from './blockDragGeometry';

const VIEW_TOP = 100;
const VIEW_BOTTOM = 700;

/** Drives `requestAnimationFrame` by hand, so a frame is a statement rather
 * than a race. The loop reads its delta from the timestamp it is handed, which
 * is what makes this deterministic. */
class FrameClock {
  private queue = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  private now = 0;
  private readonly realRaf = globalThis.requestAnimationFrame;
  private readonly realCancel = globalThis.cancelAnimationFrame;

  install(): void {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      const id = this.nextId++;
      this.queue.set(id, cb);
      return id;
    };
    globalThis.cancelAnimationFrame = (id: number): void => {
      this.queue.delete(id);
    };
  }

  restore(): void {
    globalThis.requestAnimationFrame = this.realRaf;
    globalThis.cancelAnimationFrame = this.realCancel;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** One frame `ms` later. Callbacks queued BY this frame run on the next one. */
  frame(ms = 16): void {
    this.now += ms;
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const cb of due) cb(this.now);
  }

  frames(count: number, ms = 16): void {
    for (let i = 0; i < count; i += 1) this.frame(ms);
  }
}

function fakeView(scrollHeight = 6000, clientHeight = VIEW_BOTTOM - VIEW_TOP) {
  const dom = {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({
      top: VIEW_TOP,
      bottom: VIEW_BOTTOM,
      left: 0,
      right: 390,
      width: 390,
      height: VIEW_BOTTOM - VIEW_TOP,
    }),
  };
  return { view: { dom } as unknown as ProseView, dom };
}

describe('createDragAutoScroller', () => {
  // A fresh clock per test, so one test's deliberately-still-running loop can
  // never be mistaken for the next test's leak.
  let clock: FrameClock;

  beforeEach(() => {
    clock = new FrameClock();
    clock.install();
  });
  afterEach(() => clock.restore());

  it('keeps scrolling a stationary pointer held in the bottom edge zone', () => {
    const { view, dom } = fakeView();
    const scroller = createDragAutoScroller(view);

    // ONE update — a single pointermove into the zone — and then nothing. This
    // is the gesture the old per-event nudge could not serve.
    scroller.update(VIEW_BOTTOM - 12);
    clock.frames(2); // the first frame only establishes the clock
    const afterTwo = dom.scrollTop;
    expect(afterTwo).toBeGreaterThan(0);

    clock.frames(30);
    // ~half a second of holding still has to move the note by hundreds of px,
    // not by the 14 the old helper managed for the whole gesture.
    expect(dom.scrollTop).toBeGreaterThan(afterTwo + 400);
  });

  it('ramps with depth: deeper into the zone scrolls faster', () => {
    const shallow = fakeView();
    const deep = fakeView();
    const a = createDragAutoScroller(shallow.view);
    const b = createDragAutoScroller(deep.view);

    a.update(VIEW_BOTTOM - 60); // just inside the 64px zone
    b.update(VIEW_BOTTOM - 1); // right at the edge
    clock.frames(11);

    expect(shallow.dom.scrollTop).toBeGreaterThan(0);
    expect(deep.dom.scrollTop).toBeGreaterThan(shallow.dom.scrollTop * 3);
    a.stop();
    b.stop();
  });

  it('scrolls up at the top edge and does nothing in the middle', () => {
    const { view, dom } = fakeView();
    dom.scrollTop = 2000;
    const scroller = createDragAutoScroller(view);

    scroller.update(VIEW_TOP + 12);
    clock.frames(11);
    expect(dom.scrollTop).toBeLessThan(2000);

    // Back to the middle: the loop must shut down, not coast.
    const parked = dom.scrollTop;
    scroller.update((VIEW_TOP + VIEW_BOTTOM) / 2);
    expect(clock.pending).toBe(0);
    clock.frames(20);
    expect(dom.scrollTop).toBe(parked);
  });

  it('stops at both ends instead of fighting the scroller', () => {
    const { view, dom } = fakeView(1000);
    const max = dom.scrollHeight - dom.clientHeight;
    const scroller = createDragAutoScroller(view);

    scroller.update(VIEW_BOTTOM - 1);
    clock.frames(60);
    expect(dom.scrollTop).toBe(max);
    // Held there: it must sit still, never wrap or overshoot.
    clock.frames(30);
    expect(dom.scrollTop).toBe(max);

    scroller.update(VIEW_TOP - 1);
    clock.frames(60);
    expect(dom.scrollTop).toBe(0);
    clock.frames(30);
    expect(dom.scrollTop).toBe(0);
    scroller.stop();
  });

  it('reports every frame that moved the scroller, and only those', () => {
    const { view, dom } = fakeView(1000);
    const onStep = vi.fn();
    const scroller = createDragAutoScroller(view, onStep);

    scroller.update(VIEW_BOTTOM - 1);
    clock.frames(6);
    expect(onStep).toHaveBeenCalled();
    expect(dom.scrollTop).toBeGreaterThan(0);

    // Once clamped at the end nothing moves, so nothing is reported — a
    // recompute per frame that changed nothing is pure waste mid-drag.
    clock.frames(60);
    onStep.mockClear();
    clock.frames(10);
    expect(dom.scrollTop).toBe(dom.scrollHeight - dom.clientHeight);
    expect(onStep).not.toHaveBeenCalled();
    scroller.stop();
  });

  it('stop() ends the loop, and is idempotent', () => {
    const { view, dom } = fakeView();
    const onStep = vi.fn();
    const scroller = createDragAutoScroller(view, onStep);

    scroller.update(VIEW_BOTTOM - 12);
    clock.frames(6);
    const stoppedAt = dom.scrollTop;
    expect(stoppedAt).toBeGreaterThan(0);

    scroller.stop();
    scroller.stop();
    expect(clock.pending).toBe(0);
    onStep.mockClear();
    clock.frames(60);
    // A leaked loop that keeps scrolling the note after the gesture is over is
    // worse than the bug this helper fixes.
    expect(dom.scrollTop).toBe(stoppedAt);
    expect(onStep).not.toHaveBeenCalled();
  });

  it('never runs on its own: no update() means no frames', () => {
    const { view, dom } = fakeView();
    createDragAutoScroller(view);
    expect(clock.pending).toBe(0);
    clock.frames(30);
    expect(dom.scrollTop).toBe(0);
  });

  it('caps a stalled frame so a hitch costs distance, not position', () => {
    const { view, dom } = fakeView();
    const scroller = createDragAutoScroller(view);

    scroller.update(VIEW_BOTTOM - 1);
    clock.frame(16); // establishes the clock
    // Five whole seconds of nothing — a backgrounded WebView, a GC pause. At
    // full speed that would be 7000px; the cap keeps it to one frame's worth.
    clock.frame(5000);
    expect(dom.scrollTop).toBeLessThan(100);
    scroller.stop();
  });
});
