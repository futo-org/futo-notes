// @vitest-environment jsdom
/**
 * Unit coverage for the shared drag mechanics in `blockDragGeometry.ts`: drop-slot
 * resolution, and the edge auto-scroll loop.
 *
 * The drop-slot regression this locks: the boundary between two adjacent
 * top-level blocks used to resolve to TWO targets — `{pos, corner: 'after'}`
 * from A's lower half and `{pos, corner: 'before'}` from B's upper half. Same
 * `pos`, so a drop committed to the same place either way, but the indicator
 * drew on A's bottom edge or on B's top edge and the haptic ticked crossing
 * between them: two visually distinct slots that meant one thing (MR !276).
 *
 * The auto-scroll regression this locks: the old helper stepped `scrollTop` by
 * 14px ONCE PER `pointermove`, so a finger parked in the edge zone (the only
 * gesture that can reach an off-screen boundary without lifting) produced no
 * events and therefore no scrolling at all. A device pass on a 250-block note
 * held the bottom edge for 20-25 seconds and the note never moved.
 *
 * The DOM geometry, the frame clock and the scroller are all stubs on purpose:
 * this asserts the arithmetic and lifecycle, which is exactly what is
 * unreadable from a browser run. The real touch stream through the real editor
 * is `tests/editor-embed-milkdown.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';

import { createDragAutoScroller, resolveTopLevelTarget } from './blockDragGeometry';
import { testSchema } from './__fixtures__/schema';

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

/* ---- drop slots: one per gap between top-level siblings ------------------ *
 *
 * The stub below stands in for the browser's layout: top-level blocks are laid
 * out as a vertical stack of equal boxes with a real margin between them, and
 * `posAtCoords` answers the way ProseMirror's does — a text position inside a
 * block for a point ON a block, and the bare depth-0 boundary for a point in
 * the margin BETWEEN two of them. Both entries into `resolveTopLevelTarget`
 * therefore run.
 */

const BLOCK_TOP = 100;
const BLOCK_HEIGHT = 40;
/** Real vertical space between blocks, so "in the gap" is a distinct region
 * from "on a block" and the indicator has somewhere of its own to sit. */
const BLOCK_MARGIN = 20;
const BLOCK_LEFT = 24;
const BLOCK_WIDTH = 300;
/** The content column's horizontal centre — what `contentColumnX` computes. */
const BLOCK_X = BLOCK_LEFT + BLOCK_WIDTH / 2;

const s = testSchema;

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

function quote(...texts: string[]): ProseNode {
  return s.nodes.blockquote.create(null, texts.map(paragraph));
}

function rectAt(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: BLOCK_LEFT,
    right: BLOCK_LEFT + BLOCK_WIDTH,
    width: BLOCK_WIDTH,
    height: bottom - top,
    x: BLOCK_LEFT,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** The first position inside `[start, end)` whose parent holds inline content —
 * i.e. what `posAtCoords` returns for a point on the block's text, at whatever
 * depth that text happens to live. */
function textPosInside(doc: ProseNode, start: number, end: number): number {
  for (let pos = start + 1; pos < end; pos += 1) {
    if (doc.resolve(pos).parent.inlineContent) return pos;
  }
  return start + 1;
}

type StubBlock = { pos: number; end: number; top: number; bottom: number; el: HTMLElement };

function fakeDragView(children: ProseNode[]) {
  const doc = s.nodes.doc.create(null, children);
  const state = EditorState.create({ doc });

  const blocks: StubBlock[] = [];
  let pos = 0;
  let top = BLOCK_TOP;
  doc.forEach((node) => {
    const el = document.createElement('div');
    const blockTop = top;
    const bottom = top + BLOCK_HEIGHT;
    el.getBoundingClientRect = () => rectAt(blockTop, bottom);
    blocks.push({ pos, end: pos + node.nodeSize, top: blockTop, bottom, el });
    pos += node.nodeSize;
    top = bottom + BLOCK_MARGIN;
  });

  const view = {
    state,
    dom: {
      getBoundingClientRect: () =>
        rectAt(BLOCK_TOP - BLOCK_MARGIN, blocks[blocks.length - 1].bottom + BLOCK_MARGIN),
    },
    nodeDOM: (at: number) => blocks.find((block) => block.pos === at)?.el ?? null,
    posAtCoords: ({ top: y }: { left: number; top: number }) => {
      const on = blocks.find((block) => y >= block.top && y <= block.bottom);
      if (on) return { pos: textPosInside(doc, on.pos, on.end), inside: -1 };
      // In a margin, above the first block, or below the last: the depth-0
      // boundary itself.
      const below = blocks.find((block) => block.top > y);
      return { pos: below ? below.pos : doc.content.size, inside: -1 };
    },
  } as unknown as ProseView;

  return { view, doc, blocks };
}

/** Every distinct place the indicator can be drawn, swept a pixel at a time
 * from above the first block to below the last. */
function sweepSlots(view: ProseView, blocks: StubBlock[]): string[] {
  const seen: string[] = [];
  const from = blocks[0].top - BLOCK_MARGIN;
  const to = blocks[blocks.length - 1].bottom + BLOCK_MARGIN;
  for (let y = from; y <= to; y += 1) {
    const target = resolveTopLevelTarget(view, BLOCK_X, y);
    if (!target) continue;
    const key = `${target.pos}@${target.indicator.top}`;
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

describe('resolveTopLevelTarget', () => {
  it('resolves ONE target for the gap between two blocks, from either side', () => {
    const { view, blocks } = fakeDragView([paragraph('a'), paragraph('b'), paragraph('c')]);

    // The lower half of "a" and the upper half of "b" are the same boundary.
    const fromAbove = resolveTopLevelTarget(view, BLOCK_X, blocks[0].bottom - 4);
    const fromBelow = resolveTopLevelTarget(view, BLOCK_X, blocks[1].top + 4);
    const fromTheGapItself = resolveTopLevelTarget(view, BLOCK_X, blocks[0].bottom + 10);

    expect(fromAbove?.pos).toBe(blocks[1].pos);
    expect(fromBelow).toEqual(fromAbove);
    expect(fromTheGapItself).toEqual(fromAbove);

    // And the line is drawn IN the gap, not on either block's edge — which is
    // what made one boundary look like two places to drop.
    expect(fromAbove?.indicator.top).toBe((blocks[0].bottom + blocks[1].top) / 2);
  });

  it('has exactly one slot per boundary across the whole document', () => {
    const { view, doc, blocks } = fakeDragView([
      paragraph('a'),
      paragraph('b'),
      paragraph('c'),
      paragraph('d'),
    ]);

    // Four blocks have five boundaries: before the first, between each pair,
    // after the last. The old before/after model produced eight.
    const slots = sweepSlots(view, blocks);
    expect(slots).toEqual([
      `0@${blocks[0].top}`,
      `${blocks[1].pos}@${(blocks[0].bottom + blocks[1].top) / 2}`,
      `${blocks[2].pos}@${(blocks[1].bottom + blocks[2].top) / 2}`,
      `${blocks[3].pos}@${(blocks[2].bottom + blocks[3].top) / 2}`,
      `${doc.content.size}@${blocks[3].bottom}`,
    ]);
    expect(slots).toHaveLength(blocks.length + 1);
  });

  it("draws the first gap on the first block's top edge", () => {
    const { view, blocks } = fakeDragView([paragraph('a'), paragraph('b')]);

    const fromAbove = resolveTopLevelTarget(view, BLOCK_X, blocks[0].top - 8);
    const fromInside = resolveTopLevelTarget(view, BLOCK_X, blocks[0].top + 4);

    expect(fromInside?.pos).toBe(0);
    expect(fromInside).toEqual(fromAbove);
    // Nothing above it to split the difference with, so it sits on the edge.
    expect(fromInside?.indicator.top).toBe(blocks[0].top);
  });

  it("draws the last gap on the last block's bottom edge", () => {
    const { view, doc, blocks } = fakeDragView([paragraph('a'), paragraph('b')]);
    const last = blocks[blocks.length - 1];

    const fromInside = resolveTopLevelTarget(view, BLOCK_X, last.bottom - 4);
    const fromBelow = resolveTopLevelTarget(view, BLOCK_X, last.bottom + 8);

    expect(fromInside?.pos).toBe(doc.content.size);
    expect(fromInside).toEqual(fromBelow);
    expect(fromInside?.indicator.top).toBe(last.bottom);
  });

  it('snaps a nested block out to ONE slot, shared with the sibling below it', () => {
    const { view, blocks } = fakeDragView([quote('inside one', 'inside two'), paragraph('after')]);
    const [blockquote, after] = blocks;

    // A point on the blockquote's text resolves several levels deep; it must
    // still land on the top-level boundary, and on the SAME one the paragraph
    // below reports.
    const fromInsideTheQuote = resolveTopLevelTarget(view, BLOCK_X, blockquote.bottom - 4);
    const fromTheParagraph = resolveTopLevelTarget(view, BLOCK_X, after.top + 4);

    expect(fromInsideTheQuote?.pos).toBe(after.pos);
    expect(fromTheParagraph).toEqual(fromInsideTheQuote);
    expect(fromInsideTheQuote?.indicator.top).toBe((blockquote.bottom + after.top) / 2);
  });

  it("keeps the blockquote's own two boundaries distinct", () => {
    const { view, blocks } = fakeDragView([
      paragraph('before'),
      quote('inside'),
      paragraph('after'),
    ]);
    const [before, blockquote] = blocks;

    // Its upper half is the gap ABOVE it and its lower half the gap BELOW —
    // two different positions, so two slots. Collapsing per-gap must not
    // collapse these.
    const above = resolveTopLevelTarget(view, BLOCK_X, blockquote.top + 4);
    const below = resolveTopLevelTarget(view, BLOCK_X, blockquote.bottom - 4);

    expect(above?.pos).toBe(blockquote.pos);
    expect(below?.pos).toBe(blockquote.end);
    expect(above?.indicator.top).toBe((before.bottom + blockquote.top) / 2);
  });
});

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
