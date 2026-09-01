import { describe, expect, it } from 'vitest';

import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { moveTopLevelBlock } from './blockMove';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

function heading(level: number, text: string): ProseNode {
  return s.nodes.heading.create({ level }, s.text(text));
}

function frontmatter(value: string): ProseNode {
  return s.nodes.frontmatter.create({ value });
}

/** A stub view: `moveTopLevelBlock` only reads `state` and calls `dispatch`. */
function stubView(doc: ProseNode) {
  const dispatched: Transaction[] = [];
  const state = EditorState.create({ doc });
  const view = {
    state,
    dispatch: (tr: Transaction) => dispatched.push(tr),
  } as unknown as ProseView;
  return { view, dispatched };
}

/** Position immediately before the `index`-th top-level child. */
function startOf(doc: ProseNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return pos;
}

function rangeOf(doc: ProseNode, index: number) {
  const from = startOf(doc, index);
  return { from, to: from + doc.child(index).nodeSize };
}

function topLevelText(doc: ProseNode): string[] {
  const out: string[] = [];
  doc.forEach((node) => out.push(node.textContent));
  return out;
}

describe('moveTopLevelBlock', () => {
  it('moves a block to a later top-level boundary as one transaction', () => {
    const doc = s.nodes.doc.create(null, [paragraph('a'), paragraph('b'), paragraph('c')]);
    const { view, dispatched } = stubView(doc);

    // Drop "a" at the boundary after "c" (the end of the document).
    const committed = moveTopLevelBlock(view, rangeOf(doc, 0), doc.content.size);

    expect(committed).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(topLevelText(dispatched[0].doc)).toEqual(['b', 'c', 'a']);
  });

  it('moves a block to an earlier boundary', () => {
    const doc = s.nodes.doc.create(null, [paragraph('a'), paragraph('b'), paragraph('c')]);
    const { view, dispatched } = stubView(doc);

    const committed = moveTopLevelBlock(view, rangeOf(doc, 2), 0);

    expect(committed).toBe(true);
    expect(topLevelText(dispatched[0].doc)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the node type: a heading dropped after a paragraph is still a heading', () => {
    const doc = s.nodes.doc.create(null, [heading(2, 'title'), paragraph('body')]);
    const { view, dispatched } = stubView(doc);

    const committed = moveTopLevelBlock(view, rangeOf(doc, 0), doc.content.size);

    expect(committed).toBe(true);
    const moved = dispatched[0].doc.child(1);
    expect(moved.type.name).toBe('heading');
    expect(moved.attrs.level).toBe(2);
  });

  // The reason this module exists rather than ProseMirror's own drop handling:
  // `dropPoint()` snaps to the nearest SCHEMA-VALID slot, which just below a
  // blockquote is a position INSIDE it. Callers resolve top-level boundaries
  // themselves, and a target that is not one is refused here.
  it('refuses a target position inside another block', () => {
    const quote = s.nodes.blockquote.create(null, paragraph('quoted'));
    const doc = s.nodes.doc.create(null, [paragraph('a'), quote]);
    const { view, dispatched } = stubView(doc);

    // One position inside the blockquote (a valid child slot, not a top-level gap).
    const insideQuote = startOf(doc, 1) + 1;
    const committed = moveTopLevelBlock(view, rangeOf(doc, 0), insideQuote);

    expect(committed).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('is a true no-op when the block is dropped back at its own range', () => {
    const doc = s.nodes.doc.create(null, [paragraph('a'), paragraph('b')]);
    const { view, dispatched } = stubView(doc);
    const range = rangeOf(doc, 0);

    // Both edges and everything between count as "dropped where it started".
    expect(moveTopLevelBlock(view, range, range.from)).toBe(false);
    expect(moveTopLevelBlock(view, range, range.to)).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('refuses a source range that is no longer exactly one top-level node', () => {
    const doc = s.nodes.doc.create(null, [paragraph('a'), paragraph('b'), paragraph('c')]);
    const { view, dispatched } = stubView(doc);
    const first = rangeOf(doc, 0);

    // A range spanning two blocks — what a stale drag-start capture looks like
    // after something else edited the document mid-drag.
    const twoBlocks = { from: first.from, to: rangeOf(doc, 1).to };
    expect(moveTopLevelBlock(view, twoBlocks, doc.content.size)).toBe(false);

    // A range that starts inside a block rather than before it.
    expect(moveTopLevelBlock(view, { from: first.from + 1, to: first.to }, doc.content.size)).toBe(
      false,
    );
    expect(dispatched).toHaveLength(0);
  });

  it('runs beforeDispatch on the move transaction, once, before dispatching', () => {
    const doc = s.nodes.doc.create(null, [paragraph('a'), paragraph('b')]);
    const { view, dispatched } = stubView(doc);
    const seen: Transaction[] = [];

    moveTopLevelBlock(view, rangeOf(doc, 0), doc.content.size, (tr) => seen.push(tr));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(dispatched[0]);
  });

  /* Front matter only means front matter at the very start of a file. A block
   * dropped above it, or the block itself dragged down, would put `---` in the
   * middle of the note — which the next open reads back as a thematic break
   * plus a setext heading, prose-escaping the metadata values on the way
   * (packages/editor/src/milkdown-compat/frontmatter.ts). */
  it('refuses to move a block above the front matter block', () => {
    const doc = s.nodes.doc.create(null, [frontmatter('title: T'), paragraph('a'), paragraph('b')]);
    const { view, dispatched } = stubView(doc);

    const committed = moveTopLevelBlock(view, rangeOf(doc, 2), 0);

    expect(committed).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('refuses to move the front matter block itself', () => {
    const doc = s.nodes.doc.create(null, [frontmatter('title: T'), paragraph('a')]);
    const { view, dispatched } = stubView(doc);

    const committed = moveTopLevelBlock(view, rangeOf(doc, 0), doc.content.size);

    expect(committed).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('still reorders body blocks in a note that has front matter', () => {
    const doc = s.nodes.doc.create(null, [frontmatter('title: T'), paragraph('a'), paragraph('b')]);
    const { view, dispatched } = stubView(doc);

    const committed = moveTopLevelBlock(view, rangeOf(doc, 1), doc.content.size);

    expect(committed).toBe(true);
    // The atom carries no text content, hence the leading '' — the value it
    // holds is asserted on the node itself below.
    expect(topLevelText(dispatched[0].doc)).toEqual(['', 'b', 'a']);
    expect(dispatched[0].doc.firstChild?.type.name).toBe('frontmatter');
    expect(dispatched[0].doc.firstChild?.attrs.value).toBe('title: T');
  });

  it('does not run beforeDispatch for a refused move', () => {
    const doc = s.nodes.doc.create(null, [paragraph('a'), paragraph('b')]);
    const { view } = stubView(doc);
    const range = rangeOf(doc, 0);
    let ran = false;

    moveTopLevelBlock(view, range, range.from, () => {
      ran = true;
    });

    expect(ran).toBe(false);
  });
});
