/*
 * The bounded-work half of every Milkdown decoration plugin we run.
 *
 * Typing is sacred (AGENTS.md M5): a plugin may not do work proportional to
 * the document on a keystroke. The shape that satisfies that is always the
 * same — map the existing decorations through the transaction, then rebuild
 * only the blocks the transaction's own steps touched — so it lives here once
 * instead of once per plugin.
 *
 * The two ProseMirror highlight plugins on npm both fail this at our document
 * sizes, which is why this exists rather than a dependency. Measured on a
 * 14k-line note with 280 fences (a fast desktop, August 2026):
 * `prosemirror-highlight` spends 82 ms per keystroke — its decoration cache
 * calls `doc.nodeAt` once per code block, and `doc.nodeAt` scans the
 * document's children, so the cost is fences × blocks; and
 * `@milkdown/plugin-prism` walks the whole document twice on any edit that
 * spans two blocks (pressing Enter), re-highlighting every fence. Both are
 * fine for a page-sized document and neither is fine for a note.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { Mapping } from '@milkdown/kit/prose/transform';
import type { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

/** A block a decorator owns, with the position immediately before it. */
export interface PositionedBlock {
  node: ProseNode;
  pos: number;
}

/**
 * The ranges a transaction changed, expressed in the document it produced.
 *
 * `tr.mapping.maps[i]` reports its changes in the document THAT step produced,
 * so each has to be carried forward through the steps after it before the
 * ranges mean anything in `tr.doc`.
 */
export function changedRanges(tr: { mapping: Mapping }): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  tr.mapping.maps.forEach((stepMap, index) => {
    const rest = tr.mapping.slice(index + 1);
    stepMap.forEach((_fromA, _toA, fromB, toB) => {
      ranges.push([rest.map(fromB, -1), rest.map(toB, 1)]);
    });
  });
  return ranges;
}

/**
 * `set`, with the decorations of every block in `ranges` rebuilt by `decorate`
 * and everything else left as it is.
 *
 * `set` must already be mapped through the transaction; this only replaces
 * what changed. Callers pass `blocksIn` to say which blocks they own.
 */
export function repaintBlocks(
  set: DecorationSet,
  doc: ProseNode,
  ranges: Array<[number, number]>,
  blocksIn: (doc: ProseNode, from: number, to: number) => PositionedBlock[],
  decorate: (node: ProseNode, pos: number) => Decoration[],
): DecorationSet {
  let next = set;
  for (const [from, to] of ranges) {
    const start = Math.max(0, Math.min(from, doc.content.size));
    const end = Math.max(start, Math.min(to, doc.content.size));
    for (const { node, pos } of blocksIn(doc, start, end)) {
      next = next.remove(next.find(pos, pos + node.nodeSize)).add(doc, decorate(node, pos));
    }
  }
  return next;
}
