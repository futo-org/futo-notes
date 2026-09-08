import { describe, expect, it, vi } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { createBlockSerializer, partitionUnits, type BlockSerializerDeps } from './blockSerializer';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

const p = (text = ''): ProseNode =>
  text === '' ? s.nodes.paragraph.create(null) : s.nodes.paragraph.create(null, s.text(text));
/** A `paragraph` node with no content — this editor's only spelling of a blank line. */
const emptyP = (): ProseNode => s.nodes.paragraph.create(null);
const item = (text: string): ProseNode => s.nodes.list_item.create(null, p(text));
const bullets = (...items: ProseNode[]): ProseNode => s.nodes.bullet_list.create(null, items);
const ordered = (...items: ProseNode[]): ProseNode => s.nodes.ordered_list.create(null, items);
const doc = (...blocks: ProseNode[]): ProseNode => s.nodes.doc.create(null, blocks);
const list = (...names: string[]): ProseNode => bullets(...names.map(item));
const heading = (text: string): ProseNode => s.nodes.heading.create({ level: 1 }, s.text(text));
const blockquote = (...blocks: ProseNode[]): ProseNode => s.nodes.blockquote.create(null, blocks);

/** Node-type tag used only to make partition-test failures readable. */
function tag(node: ProseNode): string {
  if (node.type.name === 'paragraph') {
    return node.content.size === 0 ? 'empty' : `p(${node.textContent})`;
  }
  if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') return 'list';
  if (node.type.name === 'heading') return `h(${node.textContent})`;
  if (node.type.name === 'blockquote') return 'blockquote';
  return node.type.name;
}

function tagUnits(units: ProseNode[][]): string[][] {
  return units.map((unit) => unit.map(tag));
}

describe('partitionUnits', () => {
  it('splits list, empty, list, empty, p into [[p],[list,empty,list],[empty],[p]]', () => {
    const document = doc(p('x'), list('a'), emptyP(), list('b'), emptyP(), p('y'));
    expect(tagUnits(partitionUnits(document))).toEqual([
      ['p(x)'],
      ['list', 'empty', 'list'],
      ['empty'],
      ['p(y)'],
    ]);
  });

  it('merges two adjacent lists into one unit', () => {
    const document = doc(list('a'), list('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([['list', 'list']]);
  });

  it('does not fold a trailing empty paragraph into the preceding list', () => {
    const document = doc(list('a'), emptyP());
    expect(tagUnits(partitionUnits(document))).toEqual([['list'], ['empty']]);
  });

  it('splits list, p, list into three units', () => {
    const document = doc(list('a'), p('mid'), list('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([['list'], ['p(mid)'], ['list']]);
  });

  it('merges a longer alternating run: list, empty, empty, list, list', () => {
    // Two consecutive empty paragraphs still count as "emptyParagraph*",
    // and a list immediately following another list joins the same run.
    const document = doc(list('a'), emptyP(), emptyP(), list('b'), list('c'));
    expect(tagUnits(partitionUnits(document))).toEqual([
      ['list', 'empty', 'empty', 'list', 'list'],
    ]);
  });

  it('treats non-list nodes as their own unit, including ordered lists next to bullet lists', () => {
    const document = doc(p('a'), ordered(item('1')), emptyP(), bullets(item('x')));
    expect(tagUnits(partitionUnits(document))).toEqual([['p(a)'], ['list', 'empty', 'list']]);
  });

  // Class 1 (direct, one-hop): a list's bulletLastUsed reaches its very next
  // sibling if that sibling is not a leaf — a blockquote might hide a nested
  // list as its own first child, so it must share the list's unit.
  it('merges a list directly followed by a blockquote (its first child may itself be a list)', () => {
    const document = doc(list('a'), blockquote(p('inside')));
    expect(tagUnits(partitionUnits(document))).toEqual([['list', 'blockquote']]);
  });

  it('splits a list directly followed by an ordinary (non-empty) paragraph', () => {
    const document = doc(list('a'), p('x'));
    expect(tagUnits(partitionUnits(document))).toEqual([['list'], ['p(x)']]);
  });

  // Class 2 (the blankLineJoin WeakMap, arbitrary range): a live entry
  // persists through any number of leaf siblings until either a genuine
  // RESTORE (empty, list) consumes it or a (non-empty, non-empty) pair
  // clears it — confirmed against the real mdast-util-to-markdown +
  // blankLineJoin sources directly, not just the ProseMirror-level model
  // (see the module header).
  it('merges list, empty, heading, empty, list into ONE unit — the entry survives past a heading', () => {
    const document = doc(list('a'), emptyP(), heading('H'), emptyP(), list('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([
      ['list', 'empty', 'h(H)', 'empty', 'list'],
    ]);
  });

  it('splits list, paragraph, empty, list into four units — the paragraph clears the entry', () => {
    // (list, paragraph) is a (non-empty, non-empty) pair once the list's own
    // bullet is settled, which is exactly what blankLineJoin's delete
    // condition requires — so nothing survives to the second list.
    const document = doc(list('a'), p('mid'), emptyP(), list('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([['list'], ['p(mid)'], ['empty'], ['list']]);
  });

  it('merges blockquote, empty, list into one unit (conservative — the blockquote might have primed it internally)', () => {
    const document = doc(blockquote(p('inside')), emptyP(), list('a'));
    expect(tagUnits(partitionUnits(document))).toEqual([['blockquote', 'empty', 'list']]);
  });

  it('splits paragraph, empty, paragraph into three units — nothing here ever touches the list machinery', () => {
    const document = doc(p('a'), emptyP(), p('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([['p(a)'], ['empty'], ['p(b)']]);
  });

  it('merges list, empty, empty, list into one unit', () => {
    const document = doc(list('a'), emptyP(), emptyP(), list('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([['list', 'empty', 'empty', 'list']]);
  });

  it('mixes both classes: heading, list, blockquote, paragraph, list', () => {
    const document = doc(heading('H'), list('a'), blockquote(p('inside')), p('mid'), list('b'));
    expect(tagUnits(partitionUnits(document))).toEqual([
      ['h(H)'],
      ['list', 'blockquote'],
      ['p(mid)'],
      ['list'],
    ]);
  });
});

/**
 * A deterministic stand-in for Milkdown's `serializeDoc`/`getMarkdown()`, so
 * the join/cache/prime tests exercise `createBlockSerializer`'s own logic
 * rather than the real remark pipeline (already confirmed against the actual
 * library sources in blockSerializer.ts's header comment).
 *
 * Mirrors exactly the one behavior blockSerializer.ts depends on from
 * `toMarkdown`: a non-empty result gets exactly one trailing `\n`, an empty
 * result gets none. An empty paragraph renders as `''` — the real paragraph
 * handler's own behavior, and the one the join tests below depend on (a
 * `tag()`-style label would never be empty and would falsify every "an empty
 * paragraph contributes nothing" assertion). A list renders as its `tag()`
 * label, since no test here inspects a list's own text.
 */
function render(node: ProseNode): string {
  if (node.type.name === 'paragraph') return node.textContent;
  return tag(node);
}

function fakeSerializeDoc(node: ProseNode): string {
  const children: ProseNode[] = [];
  node.forEach((child) => children.push(child));
  const body = children.map(render).join('+');
  return body === '' ? '' : `${body}\n`;
}

function fakeCreateDoc(nodes: ProseNode[]): ProseNode {
  return doc(...nodes);
}

function makeSerializer(): {
  serializer: ReturnType<typeof createBlockSerializer>;
  serializeDoc: ReturnType<typeof vi.fn>;
} {
  const serializeDoc = vi.fn((node: ProseNode) => fakeSerializeDoc(node));
  const deps: BlockSerializerDeps = { serializeDoc, createDoc: fakeCreateDoc };
  return { serializer: createBlockSerializer(deps), serializeDoc };
}

describe('createBlockSerializer — join', () => {
  it('joins two ordinary blocks with a blank line and one trailing newline', () => {
    const { serializer } = makeSerializer();
    expect(serializer.serialize(doc(p('hello'), p('world')))).toBe('hello\n\nworld\n');
  });

  it('joins with a single newline right after an empty paragraph', () => {
    const { serializer } = makeSerializer();
    expect(serializer.serialize(doc(p('a'), emptyP(), p('b')))).toBe('a\n\n\nb\n');
  });

  it('serializes a lone empty paragraph to the empty string', () => {
    const { serializer } = makeSerializer();
    expect(serializer.serialize(doc(emptyP()))).toBe('');
  });

  it('adds no extra trailing newline when a doc ends with an empty paragraph', () => {
    const { serializer } = makeSerializer();
    // separator before the trailing empty unit is already '\n\n' (its
    // predecessor is not itself an empty paragraph), so the whole already
    // ends in '\n' and toMarkdown's own append does not fire again.
    expect(serializer.serialize(doc(p('a'), emptyP()))).toBe('a\n\n');
  });

  it('never doubles the trailing newline for a single block', () => {
    const { serializer } = makeSerializer();
    expect(serializer.serialize(doc(p('hello')))).toBe('hello\n');
  });
});

describe('createBlockSerializer — cache', () => {
  it('costs zero extra calls serializing the same doc twice', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const document = doc(p('a'), p('b'), p('c'));
    serializer.serialize(document);
    const callsAfterFirst = serializeDoc.mock.calls.length;
    expect(callsAfterFirst).toBe(3);
    serializer.serialize(document);
    expect(serializeDoc.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-serializes exactly the one unit whose node identity changed', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const a = p('a');
    const b = p('b');
    const c = p('c');
    serializer.serialize(doc(a, b, c));
    expect(serializeDoc.mock.calls.length).toBe(3);

    const b2 = p('bb');
    serializer.serialize(doc(a, b2, c));
    expect(serializeDoc.mock.calls.length).toBe(4);
  });

  it('re-serializes a whole list run as one unit when any member changes', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const l1 = list('a');
    const gap = emptyP();
    const l2 = list('b');
    const tail = p('tail');
    serializer.serialize(doc(l1, gap, l2, tail));
    // Two units: [l1, gap, l2] and [tail].
    expect(serializeDoc.mock.calls.length).toBe(2);

    const l2changed = list('b-changed');
    serializer.serialize(doc(l1, gap, l2changed, tail));
    // The run unit's first node (l1) is unchanged, but the run no longer
    // matches (different length is not the issue here — same length, but
    // nodes[2] !== l2changed) so the whole run re-serializes; `tail` is
    // still a hit.
    expect(serializeDoc.mock.calls.length).toBe(3);
  });

  it('treats a node that only moved position as a cache hit', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const a = p('a');
    const b = p('b');
    const c = p('c');
    serializer.serialize(doc(a, b, c));
    expect(serializeDoc.mock.calls.length).toBe(3);

    serializer.serialize(doc(c, a, b));
    expect(serializeDoc.mock.calls.length).toBe(3);
  });
});

describe('createBlockSerializer — prime', () => {
  it('serializes at least one unit per call and reports done only once every unit lands', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const document = doc(p('a'), p('b'), p('c'));
    const timeIsUp = () => 0;

    expect(serializer.isPrimed(document)).toBe(false);

    expect(serializer.prime(document, timeIsUp)).toBe(false);
    expect(serializeDoc.mock.calls.length).toBe(1);
    expect(serializer.isPrimed(document)).toBe(false);

    expect(serializer.prime(document, timeIsUp)).toBe(false);
    expect(serializeDoc.mock.calls.length).toBe(2);

    expect(serializer.prime(document, timeIsUp)).toBe(true);
    expect(serializeDoc.mock.calls.length).toBe(3);
    expect(serializer.isPrimed(document)).toBe(true);
  });

  it('with a budget that reports time up immediately, still primes exactly one unit and reports incomplete when more remain', () => {
    // The property MilkdownEditor.svelte's synchronous priming budget relies
    // on: even a budget function that never allows a SECOND unit still makes
    // forward progress (didWork-gated in createBlockSerializer, not a bare
    // "stop if time <= 0" check), and correctly reports it did not finish.
    const { serializer, serializeDoc } = makeSerializer();
    const document = doc(p('a'), p('b'), p('c'));
    expect(serializer.prime(document, () => -1)).toBe(false);
    expect(serializeDoc.mock.calls.length).toBe(1);
    expect(serializer.isPrimed(document)).toBe(false);
  });

  it('with a budget that reports time up immediately, still returns true for a doc with exactly one uncached unit', () => {
    // The other half of the same property: a document that only needs ONE
    // more unit primes to completion in a single call, however small the
    // budget reports itself to be — this is what lets a small note's edit
    // finish priming synchronously inside reportDocumentChange's tight budget
    // instead of always taking the async idle-loop detour.
    const { serializer, serializeDoc } = makeSerializer();
    const document = doc(p('only'));
    expect(serializer.prime(document, () => -1)).toBe(true);
    expect(serializeDoc.mock.calls.length).toBe(1);
    expect(serializer.isPrimed(document)).toBe(true);
  });

  it('primes every unit in one call when time never runs out', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const document = doc(p('a'), p('b'), p('c'));
    expect(serializer.prime(document, () => 1000)).toBe(true);
    expect(serializeDoc.mock.calls.length).toBe(3);
    expect(serializer.isPrimed(document)).toBe(true);
  });

  it('is a no-op once already primed', () => {
    const { serializer, serializeDoc } = makeSerializer();
    const document = doc(p('a'), p('b'));
    serializer.serialize(document);
    expect(serializeDoc.mock.calls.length).toBe(2);
    expect(serializer.prime(document, () => 0)).toBe(true);
    expect(serializeDoc.mock.calls.length).toBe(2);
  });
});
