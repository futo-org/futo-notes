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
import { DecorationSet, type Decoration } from '@milkdown/kit/prose/view';

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
 *
 * REQUIREMENT ON `blocksIn`: the blocks it returns must not contain one
 * another. Rebuilding a block clears its whole range first, so a block nested
 * inside another would have its decorations cleared by the parent's rebuild and
 * never put back. Textblocks and fenced code blocks satisfy this for free; task
 * items do not, and `taskCheckbox.ts` returns only outermost items with a
 * `decorate` that covers their whole subtree.
 */
export function repaintBlocks(
  set: DecorationSet,
  doc: ProseNode,
  ranges: Array<[number, number]>,
  blocksIn: (doc: ProseNode, from: number, to: number) => PositionedBlock[],
  decorate: (node: ProseNode, pos: number) => Decoration[],
): DecorationSet {
  let next = set;
  for (const range of ranges) {
    const [start, end] = expandToBlocks(doc, range[0], range[1]);
    // Clear the range BEFORE re-decorating it. Rebuilding block by block only
    // ever removes decorations belonging to a block that is STILL THERE, so a
    // transaction that deletes one left its mapped decoration behind: lifting a
    // task item clear of its list (Shift+Tab, or the toolbar's Task button)
    // stranded the checkbox widget on the plain paragraph it became.
    // Decorations owned by a block that merely straddles the range are not
    // contained by it and so survive; the per-block clear below still catches a
    // surviving block whose decorations reach outside the range.
    next = next.remove(decorationsWithin(next, start, end));
    for (const { node, pos } of blocksIn(doc, start, end)) {
      next = next
        .remove(decorationsWithin(next, pos, pos + node.nodeSize))
        .add(doc, decorate(node, pos));
    }
  }
  return next;
}

/**
 * `[from, to]` widened to the top-level blocks it touches.
 *
 * A step that changes STRUCTURE rather than text reports zero-width ranges: a
 * lift out of a list rewrites the wrappers on either side of the content and
 * leaves the content itself untouched, so `changedRanges` answers with the two
 * collapsed boundaries (`[[0,0],[7,7]]` for a one-item list) and a decoration
 * sitting in the middle is in neither. Widening to the block means the repaint
 * sees the paragraph that the item became.
 *
 * Still bounded (AGENTS.md M5): every step here is a `resolve`, which costs the
 * document's DEPTH, and the widened range covers the one or two top-level
 * blocks at the edit — never a walk of the document's children.
 */
function expandToBlocks(doc: ProseNode, from: number, to: number): [number, number] {
  const start = Math.max(0, Math.min(from, doc.content.size));
  const end = Math.max(start, Math.min(to, doc.content.size));
  const $start = doc.resolve(start);
  const $end = doc.resolve(end);
  // A position at depth 0 sits BETWEEN top-level blocks rather than inside one.
  // Reaching out to the neighbour there is only right when the range is EMPTY:
  // a range with width already covers whole blocks, and widening past them
  // would repaint a block the transaction never touched.
  const empty = start === end;
  const blockStart =
    $start.depth > 0 ? $start.before(1) : start - (empty ? ($start.nodeBefore?.nodeSize ?? 0) : 0);
  const blockEnd =
    $end.depth > 0 ? $end.after(1) : end + (empty ? ($end.nodeAfter?.nodeSize ?? 0) : 0);
  return [Math.max(0, blockStart), Math.min(doc.content.size, Math.max(blockStart, blockEnd))];
}

/**
 * The decorations that belong to `[from, to]` — contained by it, not merely
 * touching it.
 *
 * `DecorationSet.find` returns everything that TOUCHES the range, and a node
 * decoration on the next block starts exactly where this one ends. Removing
 * what `find` returns therefore takes the neighbour's decorations with it, and
 * nothing puts them back: only the blocks inside the changed ranges get
 * rebuilt. Typing in one fence would silently un-highlight the fence below it.
 */
function decorationsWithin(set: DecorationSet, from: number, to: number): Decoration[] {
  return set.find(from, to).filter((decoration) => decoration.from >= from && decoration.to <= to);
}

/** Decorations for every block `blocksIn` owns — the whole-document build. */
export function decorateAllBlocks(
  doc: ProseNode,
  blocksIn: (doc: ProseNode, from: number, to: number) => PositionedBlock[],
  decorate: (node: ProseNode, pos: number) => Decoration[],
): DecorationSet {
  return DecorationSet.create(
    doc,
    blocksIn(doc, 0, doc.content.size).flatMap(({ node, pos }) => decorate(node, pos)),
  );
}

/**
 * A fenced code block: a textblock whose schema says its content is code. The
 * one predicate both decorators key off, from opposite sides — tags are never
 * inside one, highlighting is only inside one — so they cannot disagree about
 * what a fence is.
 */
export function isCodeBlock(node: ProseNode): boolean {
  return node.type.spec.code === true && node.isTextblock;
}
