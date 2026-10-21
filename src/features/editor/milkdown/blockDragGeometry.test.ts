// @vitest-environment jsdom
/**
 * Unit coverage for the drop-slot resolution in `blockDragGeometry.ts`; the edge
 * auto-scroll loop is `blockDragGeometry.autoScroll.test.ts`.
 *
 * The drop-slot regression this locks: the boundary between two adjacent
 * top-level blocks used to resolve to TWO targets — `{pos, corner: 'after'}`
 * from A's lower half and `{pos, corner: 'before'}` from B's upper half. Same
 * `pos`, so a drop committed to the same place either way, but the indicator
 * drew on A's bottom edge or on B's top edge and the haptic ticked crossing
 * between them: two visually distinct slots that meant one thing (MR !276).
 *
 * The DOM geometry is a stub on purpose: this asserts the arithmetic, which is
 * exactly what is unreadable from a browser run. The real touch stream through
 * the real editor is `tests/editor-embed-milkdown-gutter-handle-slots.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';

import { resolveDropTarget } from './blockDragGeometry';
import { testSchema } from './__fixtures__/schema';

/* ---- drop slots: one per gap between top-level siblings ------------------ *
 *
 * The stub below stands in for the browser's layout: top-level blocks are laid
 * out as a vertical stack of equal boxes with a real margin between them, and
 * `posAtCoords` answers the way ProseMirror's does — a text position inside a
 * block for a point ON a block, and the bare depth-0 boundary for a point in
 * the margin BETWEEN two of them. Both entries into `resolveDropTarget`
 * therefore run.
 */

const BLOCK_TOP = 100;
const BLOCK_HEIGHT = 40;
/** Real vertical space between blocks, so "in the gap" is a distinct region
 * from "on a block" and the indicator has somewhere of its own to sit. */
const BLOCK_MARGIN = 20;
const BLOCK_LEFT = 24;
const BLOCK_WIDTH = 300;
/** The content column's horizontal center — what `contentColumnX` computes. */
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

/** Height of one list item inside a stubbed list; items stack with no margin,
 * so a list's box is exactly its items' boxes. */
const ITEM_HEIGHT = 30;

function bullets(...texts: string[]): ProseNode {
  return s.nodes.bullet_list.create(
    null,
    texts.map((text) => s.nodes.list_item.create(null, paragraph(text))),
  );
}

function fakeDragView(children: ProseNode[]) {
  const doc = s.nodes.doc.create(null, children);
  const state = EditorState.create({ doc });

  const blocks: StubBlock[] = [];
  /** Every node with a stubbed box, innermost last — list items as well as the
   * top-level blocks, so `nodeDOM` and `posAtCoords` answer at both depths. */
  const boxes: StubBlock[] = [];
  const stub = (pos: number, node: ProseNode, top: number, bottom: number): StubBlock => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => rectAt(top, bottom);
    const box = { pos, end: pos + node.nodeSize, top, bottom, el };
    boxes.push(box);
    return box;
  };
  let pos = 0;
  let top = BLOCK_TOP;
  doc.forEach((node) => {
    const isList = node.type.name === 'bullet_list';
    const height = isList ? node.childCount * ITEM_HEIGHT : BLOCK_HEIGHT;
    blocks.push(stub(pos, node, top, top + height));
    if (isList) {
      let itemPos = pos + 1;
      let itemTop = top;
      node.forEach((item) => {
        stub(itemPos, item, itemTop, itemTop + ITEM_HEIGHT);
        itemPos += item.nodeSize;
        itemTop += ITEM_HEIGHT;
      });
    }
    pos += node.nodeSize;
    top += height + BLOCK_MARGIN;
  });

  const view = {
    state,
    dom: {
      getBoundingClientRect: () =>
        rectAt(BLOCK_TOP - BLOCK_MARGIN, blocks[blocks.length - 1].bottom + BLOCK_MARGIN),
    },
    nodeDOM: (at: number) => boxes.find((box) => box.pos === at)?.el ?? null,
    posAtCoords: ({ top: y }: { left: number; top: number }) => {
      // Innermost box wins (items were stubbed after their list).
      const on = [...boxes].reverse().find((box) => y >= box.top && y <= box.bottom);
      if (on) return { pos: textPosInside(doc, on.pos, on.end), inside: -1 };
      // In a margin, above the first block, or below the last: the depth-0
      // boundary itself.
      const below = blocks.find((block) => block.top > y);
      return { pos: below ? below.pos : doc.content.size, inside: -1 };
    },
  } as unknown as ProseView;

  /** The stubbed boxes of the items of the top-level list at `index`. */
  const itemsOf = (index: number): StubBlock[] =>
    boxes.filter((box) => box.pos > blocks[index].pos && box.end < blocks[index].end);

  return { view, doc, blocks, itemsOf };
}

/** Every distinct place the indicator can be drawn, swept a pixel at a time
 * from above the first block to below the last. */
function sweepSlots(view: ProseView, blocks: StubBlock[]): string[] {
  const seen: string[] = [];
  const from = blocks[0].top - BLOCK_MARGIN;
  const to = blocks[blocks.length - 1].bottom + BLOCK_MARGIN;
  for (let y = from; y <= to; y += 1) {
    const target = resolveDropTarget(view, BLOCK_X, y);
    if (!target) continue;
    const key = `${target.pos}@${target.indicator.top}`;
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

describe('resolveDropTarget: a top-level block', () => {
  it('resolves ONE target for the gap between two blocks, from either side', () => {
    const { view, blocks } = fakeDragView([paragraph('a'), paragraph('b'), paragraph('c')]);

    // The lower half of "a" and the upper half of "b" are the same boundary.
    const fromAbove = resolveDropTarget(view, BLOCK_X, blocks[0].bottom - 4);
    const fromBelow = resolveDropTarget(view, BLOCK_X, blocks[1].top + 4);
    const fromTheGapItself = resolveDropTarget(view, BLOCK_X, blocks[0].bottom + 10);

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

    const fromAbove = resolveDropTarget(view, BLOCK_X, blocks[0].top - 8);
    const fromInside = resolveDropTarget(view, BLOCK_X, blocks[0].top + 4);

    expect(fromInside?.pos).toBe(0);
    expect(fromInside).toEqual(fromAbove);
    // Nothing above it to split the difference with, so it sits on the edge.
    expect(fromInside?.indicator.top).toBe(blocks[0].top);
  });

  it("draws the last gap on the last block's bottom edge", () => {
    const { view, doc, blocks } = fakeDragView([paragraph('a'), paragraph('b')]);
    const last = blocks[blocks.length - 1];

    const fromInside = resolveDropTarget(view, BLOCK_X, last.bottom - 4);
    const fromBelow = resolveDropTarget(view, BLOCK_X, last.bottom + 8);

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
    const fromInsideTheQuote = resolveDropTarget(view, BLOCK_X, blockquote.bottom - 4);
    const fromTheParagraph = resolveDropTarget(view, BLOCK_X, after.top + 4);

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
    const above = resolveDropTarget(view, BLOCK_X, blockquote.top + 4);
    const below = resolveDropTarget(view, BLOCK_X, blockquote.bottom - 4);

    expect(above?.pos).toBe(blockquote.pos);
    expect(below?.pos).toBe(blockquote.end);
    expect(above?.indicator.top).toBe((before.bottom + blockquote.top) / 2);
  });
});

describe('resolveDropTarget: over a list', () => {
  it("snaps to the list's outer boundaries, never between its items", () => {
    const { view, blocks, itemsOf } = fakeDragView([paragraph('p'), bullets('a', 'b', 'c')]);
    const list = blocks[1];
    const [, b] = itemsOf(1);

    // A drop only lands in a top-level gap, so pointing at the middle item
    // resolves to whichever of the LIST's two boundaries is nearer.
    const upper = resolveDropTarget(view, BLOCK_X, b.top + 2);
    const lower = resolveDropTarget(view, BLOCK_X, b.bottom - 2);
    expect(upper?.pos).toBe(list.pos);
    expect(lower?.pos).toBe(list.end);
  });
});
