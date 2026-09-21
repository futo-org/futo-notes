/*
 * Which top-level blocks did a transaction touch?
 *
 * The one question every "only look at what changed" plugin in this directory
 * asks (listOrder.ts, tablePasses.ts). Answered from the step maps rather than
 * by diffing the two documents: a diff walks every top-level block, which at
 * 10k lines was itself 2-4ms of a keystroke on the low-end Android reference
 * phone (tests/android-editor-perf-quick.mjs --profile, 2026-09-04).
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { Transaction } from '@milkdown/kit/prose/state';

export interface TouchedRange {
  /** Position before the first touched top-level block. */
  from: number;
  /** Position after the last touched top-level block. */
  to: number;
  /** Index of the first touched top-level block in `doc`. */
  fromIndex: number;
  /** One past the index of the last touched top-level block. */
  toIndex: number;
}

/**
 * The span of `doc` (the document AFTER `transactions`) covering every
 * top-level block those transactions touched, or null when none changed the
 * document.
 */
export function touchedTopLevelRange(
  transactions: readonly Transaction[],
  doc: ProseNode,
): TouchedRange | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const tr of transactions) {
    // Carry what earlier transactions touched forward through this one.
    if (from !== Number.POSITIVE_INFINITY) {
      from = tr.mapping.map(from, -1);
      to = tr.mapping.map(to, 1);
    }
    tr.mapping.maps.forEach((map, index) => {
      const rest = tr.mapping.slice(index + 1);
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        from = Math.min(from, rest.map(newStart, -1));
        to = Math.max(to, rest.map(newEnd, 1));
      });
    });
  }
  if (from === Number.POSITIVE_INFINITY) return null;
  const size = doc.content.size;
  from = Math.max(0, Math.min(from, size));
  to = Math.max(from, Math.min(to, size));
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  return {
    from: $from.depth > 0 ? $from.before(1) : from,
    to: $to.depth > 0 ? $to.after(1) : to,
    // At depth 0 the position sits between blocks and index(0) names the block
    // after it: the first covered block for `from`, one past the last for `to`.
    fromIndex: $from.index(0),
    toIndex: $to.depth > 0 ? $to.index(0) + 1 : $to.index(0),
  };
}

/**
 * `doc.nodesBetween(range.from, range.to, f)`: the same callbacks in the same
 * order, with the same `(node, pos, parent, index)` arguments and the same
 * "return false to skip a subtree" contract — minus the scan `nodesBetween`
 * makes from the top of the document to reach the range. That scan is
 * O(blocks before the edit); typing at the end of 5,000 blocks paid it once per
 * scoped plugin, ~1 ms each on the low-end Android reference phone
 * (tests/android-editor-perf-quick.mjs, 2026-09-04).
 */
export function nodesInTouchedRange(
  doc: ProseNode,
  range: TouchedRange,
  f: (node: ProseNode, pos: number, parent: ProseNode | null, index: number) => boolean | void,
): void {
  let pos = range.from;
  for (let index = range.fromIndex; index < range.toIndex; index += 1) {
    const node = doc.child(index);
    if (f(node, pos, doc, index) !== false && node.content.size) {
      node.nodesBetween(0, node.content.size, f, pos + 1);
    }
    pos += node.nodeSize;
  }
}
