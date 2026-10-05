import { describe, expect, it, vi } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

import { changedRanges, repaintBlocks, type PositionedBlock } from './blockDecorations';
import { testSchema as s } from './__fixtures__/schema';

function para(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

/** Every top-level paragraph in `[from, to]`. */
function paragraphsIn(doc: ProseNode, from: number, to: number): PositionedBlock[] {
  const out: PositionedBlock[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) out.push({ node, pos });
    return !node.isTextblock;
  });
  return out;
}

/** One decoration covering the whole block, tagged with its text. */
function wholeBlock(node: ProseNode, pos: number): Decoration[] {
  return [
    Decoration.inline(pos + 1, pos + node.nodeSize - 1, { class: 'x' }, { text: node.textContent }),
  ];
}

type Decorate = (node: ProseNode, pos: number) => Decoration[];

function decorateAll(doc: ProseNode, blocksIn: typeof paragraphsIn, decorate: Decorate) {
  return DecorationSet.create(
    doc,
    blocksIn(doc, 0, doc.content.size).flatMap(({ node, pos }) => decorate(node, pos)),
  );
}

/**
 * Runs `run` counting reads of `Decoration#from`, by shadowing the field with a
 * prototype accessor. Only decorations constructed inside `run` are counted,
 * which is every one a repaint creates, maps or copies; `run` must finish with
 * them, since they lose the field when the accessor goes.
 */
function countingFromReads<T>(run: (reads: () => number) => T): T {
  const proto = Decoration.prototype as unknown as Record<string, unknown>;
  const value = Symbol('from');
  let reads = 0;
  Object.defineProperty(proto, 'from', {
    configurable: true,
    get(this: Record<symbol, number>) {
      reads += 1;
      return this[value];
    },
    set(this: Record<symbol, number>, from: number) {
      this[value] = from;
    },
  });
  try {
    return run(() => reads);
  } finally {
    delete proto.from;
  }
}

function docOf(...texts: string[]): ProseNode {
  return s.nodes.doc.create(null, texts.map(para));
}

describe('changedRanges', () => {
  it('is empty for a transaction that changed nothing', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    expect(changedRanges(state.tr)).toEqual([]);
  });

  it('covers the inserted text', () => {
    const state = EditorState.create({ doc: docOf('one') });
    const tr = state.tr.insertText('XY', 2);
    const [[from, to]] = changedRanges(tr);
    expect(tr.doc.textBetween(from, to)).toBe('XY');
  });

  it('reports each step of a multi-step transaction', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('a', 2).insertText('b', 9);
    expect(changedRanges(tr)).toHaveLength(2);
  });

  it('carries an early step forward through the later ones', () => {
    // Insert at the END first, then at the START: the first step's range is
    // reported in a document that the second step has since shifted.
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('LONGER', 8).insertText('Z', 1);
    for (const [from, to] of changedRanges(tr)) {
      expect(to).toBeLessThanOrEqual(tr.doc.content.size);
      expect(tr.doc.textBetween(from, to)).toMatch(/^(LONGER|Z)$/);
    }
  });
});

describe('repaintBlocks', () => {
  const texts = Array.from({ length: 500 }, (_, i) => `block ${i}`);

  function decorationsFor(doc: ProseNode): DecorationSet {
    return DecorationSet.create(
      doc,
      paragraphsIn(doc, 0, doc.content.size).flatMap(({ node, pos }) => wholeBlock(node, pos)),
    );
  }

  it('rebuilds exactly the blocks the transaction touched', () => {
    const state = EditorState.create({ doc: docOf(...texts) });
    const target = state.doc.resolve(Math.floor(state.doc.content.size / 2)).start();
    const tr = state.tr.insertText('!', target);

    const rebuilt: string[] = [];
    repaintBlocks(
      decorationsFor(state.doc).map(tr.mapping, tr.doc),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      (node, pos) => {
        rebuilt.push(node.textContent);
        return wholeBlock(node, pos);
      },
    );

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toContain('!');
  });

  it('leaves the untouched blocks with their existing decorations', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('!', 2);
    const next = repaintBlocks(
      decorationsFor(state.doc).map(tr.mapping, tr.doc),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      wholeBlock,
    );
    expect(
      next
        .find()
        .map((d) => d.spec.text)
        .sort(),
    ).toEqual(['o!ne', 'two']);
  });

  it('never leaves a block with two sets of decorations', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('!', 2);
    const next = repaintBlocks(
      decorationsFor(state.doc).map(tr.mapping, tr.doc),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      wholeBlock,
    );
    expect(next.find()).toHaveLength(2);
  });

  it('never strips the neighbouring block, whose decoration abuts this one', () => {
    // `DecorationSet.find(from, to)` returns everything TOUCHING that range,
    // and a node decoration on the next block starts exactly where this one
    // ends — so a naive remove-then-add takes the neighbour's decorations with
    // it and never puts them back. Node decorations (codeHighlight's fence
    // marker) abut exactly; inline ones sit a position inside their block.
    const first = para('one');
    const second = para('two');
    const d = s.nodes.doc.create(null, [first, second]);
    const wholeNode = (node: ProseNode, pos: number): Decoration[] => [
      Decoration.node(pos, pos + node.nodeSize, { class: 'block' }, { text: node.textContent }),
    ];
    const state = EditorState.create({ doc: d });
    const tr = state.tr.insertText('!', 2);

    const next = repaintBlocks(
      DecorationSet.create(d, [...wholeNode(first, 0), ...wholeNode(second, first.nodeSize)]).map(
        tr.mapping,
        tr.doc,
      ),
      tr.doc,
      changedRanges(tr),
      paragraphsIn,
      wholeNode,
    );

    expect(
      next
        .find()
        .map((decoration) => decoration.spec.text)
        .sort(),
    ).toEqual(['o!ne', 'two']);
  });

  it('survives a range that a later step pushed past the end of the document', () => {
    const state = EditorState.create({ doc: docOf('one', 'two') });
    const tr = state.tr.insertText('xyz', 8).delete(0, state.doc.content.size);
    expect(() =>
      repaintBlocks(
        decorationsFor(state.doc).map(tr.mapping, tr.doc),
        tr.doc,
        changedRanges(tr),
        paragraphsIn,
        wholeBlock,
      ),
    ).not.toThrow();
  });
});

describe('repaintBlocks cost', () => {
  /*
   * RC-46: the cost of rebuilding a block must not grow faster than the block.
   * Every token of a fence (every tag of a paragraph) sits in ONE node of the
   * decoration tree, and a flat task list's checkboxes sit in one node per
   * item under a single list. `DecorationSet.remove` used to compare each
   * removed decoration with every decoration left in its node — k(k+1)/2
   * `Decoration.eq` calls, 64 ms a key in a 10k-character fence — and both
   * `remove` and `add` scanned every decoration once per child node, which is
   * k x items for a task list (40 ms a key at 2,000 items).
   *
   * Counted rather than timed, so a loaded machine cannot move it: `eq` calls,
   * and reads of a decoration's `from`, which is how the tree routes one to a
   * child. Both per decoration, at 250 and 4,000.
   */
  const shapes: Array<
    [string, (k: number) => ProseNode, (doc: ProseNode) => number, typeof paragraphsIn, Decorate]
  > = [
    [
      'inline decorations in one textblock',
      (k) => docOf('ab'.repeat(k)),
      (doc) => doc.child(0).nodeSize >> 1,
      paragraphsIn,
      (node, pos) =>
        Array.from({ length: node.textContent.length >> 1 }, (_, i) =>
          Decoration.inline(pos + 1 + 2 * i, pos + 2 + 2 * i, { class: 't' }),
        ),
    ],
    [
      'widgets in one node',
      (k) => docOf('ab'.repeat(k)),
      (doc) => doc.child(0).nodeSize >> 1,
      paragraphsIn,
      (node, pos) =>
        Array.from({ length: node.textContent.length >> 1 }, (_, i) =>
          Decoration.widget(pos + 1 + 2 * i, () => document.createElement('i')),
        ),
    ],
    [
      'widgets across the items of one list',
      (k) =>
        s.nodes.doc.create(null, [
          s.nodes.bullet_list.create(
            null,
            Array.from({ length: k }, (_, i) =>
              s.nodes.list_item.create(null, [para(`task ${i}`)]),
            ),
          ),
        ]),
      (doc) => {
        const list = doc.child(0);
        let pos = 1; // inside the list
        for (let i = 0; i < list.childCount >> 1; i += 1) pos += list.child(i).nodeSize;
        return pos + 3; // item, paragraph, then one character into the text
      },
      (doc, from, to) => {
        const out: PositionedBlock[] = [];
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'list_item') out.push({ node, pos });
          return node.type.name !== 'list_item';
        });
        return out;
      },
      (_node, pos) => [Decoration.widget(pos + 2, () => document.createElement('i'))],
    ],
  ];

  it.each(shapes)(
    'does bounded work per decoration for %s',
    (_shape, build, editAt, blocksIn, decorate) => {
      const perDecoration = (k: number) => {
        const state = EditorState.create({ doc: build(k) });
        const set = decorateAll(state.doc, blocksIn, decorate);
        const tr = state.tr.insertText('x', editAt(state.doc));
        const eq = vi.spyOn(Decoration.prototype, 'eq');
        const work = countingFromReads((reads) => {
          const next = repaintBlocks(
            set.map(tr.mapping, tr.doc),
            tr.doc,
            changedRanges(tr),
            blocksIn,
            decorate,
          );
          const counted = { eq: eq.mock.calls.length / k, from: reads() / k };
          expect(next.find()).toHaveLength(k);
          return counted;
        });
        eq.mockRestore();
        return work;
      };
      const small = perDecoration(250);
      const large = perDecoration(4_000);
      const detail = JSON.stringify({ small, large });
      // Quadratic, `eq` alone was (k + 1) / 2 per decoration: 125.5 and 2,000.5.
      expect(large.eq, detail).toBeLessThanOrEqual(2);
      // Sorting by start costs log k reads each; scanning per child cost k.
      expect(large.from, detail).toBeLessThanOrEqual(2 * small.from);
    },
  );
});

describe('decoration lookup cost', () => {
  /*
   * RC-80: every redraw asks the decoration tree for each child node's own
   * decorations (`DecorationSet.forChild`), and upstream found each one by
   * scanning the tree's children from the front — O(blocks²) per keystroke in
   * a note whose blocks each carry a decoration (a #tag per section cost
   * 115 ms a key at 20,000 sections). patches/prosemirror-view makes it a
   * binary search. Counted, not timed: reads of the tree's child array per
   * lookup, at 250 and 4,000 decorated blocks.
   */
  it('finds a child’s decorations without scanning its siblings', () => {
    const readsPerBlock = (k: number): number => {
      const doc = docOf(...Array.from({ length: k }, (_, i) => `#tag${i}`));
      const set = decorateAll(doc, paragraphsIn, wholeBlock) as unknown as {
        children: unknown[];
        forChild: (offset: number, node: ProseNode) => DecorationSet;
      };
      let reads = 0;
      set.children = new Proxy(set.children, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      let found = 0;
      doc.forEach((child, offset) => {
        if (set.forChild(offset, child).find().length === 1) found += 1;
      });
      expect(found).toBe(k);
      return reads / k;
    };
    const small = readsPerBlock(250);
    const large = readsPerBlock(4_000);
    // A scan from the front read ~k/2 per lookup: ~125 and ~2,000.
    expect(large, JSON.stringify({ small, large })).toBeLessThanOrEqual(2 * small);
    expect(large).toBeLessThan(40);
  });

  /*
   * The search relies on `children` staying sorted by start through every
   * build, map, add and remove. Held here to the front-to-back scan it
   * replaced, over decoration sets that random edits have mapped, grown and
   * shrunk — nested lists included, so the lookups reach inner nodes too.
   */
  it('answers every lookup exactly as the scan from the front did', () => {
    type Tree = { children: readonly (number | Tree)[] };
    const scanned = (set: Tree, offset: number): Tree | undefined => {
      for (let i = 0; i < set.children.length; i += 3)
        if ((set.children[i] as number) >= offset)
          return set.children[i] == offset ? (set.children[i + 2] as Tree) : undefined;
      return undefined;
    };
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const item = (text: string): ProseNode => s.nodes.list_item.create(null, [para(text)]);
    const block = (i: number): ProseNode =>
      random(4) === 0
        ? s.nodes.bullet_list.create(null, [item(`item ${i}a`), item(`item ${i}b`)])
        : para(`block ${i} text`);
    const decorate = (doc: ProseNode): Decoration[] => {
      const out: Decoration[] = [];
      doc.descendants((node, pos) => {
        if (node.isTextblock && random(2) === 0) out.push(...wholeBlock(node, pos));
      });
      return out;
    };
    let lookups = 0;
    for (let round = 0; round < 300; round += 1) {
      const state = EditorState.create({
        doc: s.nodes.doc.create(
          null,
          Array.from({ length: 5 + random(40) }, (_, i) => block(i)),
        ),
      });
      let set = DecorationSet.create(state.doc, decorate(state.doc));
      let doc = state.doc;
      for (let step = 0; step < 4; step += 1) {
        const tr = EditorState.create({ doc }).tr;
        const at = 1 + random(doc.content.size - 1);
        if (random(2) === 0) tr.insertText('xy', at);
        else tr.delete(at, Math.min(doc.content.size, at + random(30)));
        set = set.map(tr.mapping, tr.doc);
        doc = tr.doc;
        const fresh = decorate(doc);
        set =
          random(2) === 0 ? set.add(doc, fresh.slice(0, 3)) : set.remove(set.find().slice(0, 2));
      }
      const compare = (tree: DecorationSet, node: ProseNode): void => {
        node.forEach((child, offset) => {
          if (child.isLeaf) return;
          lookups += 1;
          const inner = tree.forChild(offset, child);
          const expected = scanned(tree as unknown as Tree, offset);
          // Either the very subtree the scan found, or a group/local set built
          // around it — both carry that subtree's decorations.
          const found = inner as unknown as Tree & { members?: Tree[] };
          const holds =
            expected === undefined
              ? !found.members?.length && (inner === DecorationSet.empty || !found.children.length)
              : inner === (expected as unknown) || !!found.members?.includes(expected);
          expect(holds, `round ${round}, offset ${offset}`).toBe(true);
          if (inner instanceof DecorationSet) compare(inner, child);
        });
      };
      compare(set, doc);
    }
    expect(lookups).toBeGreaterThan(5_000);
  });
});
