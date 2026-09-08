/*
 * The one place a block drag turns into a document change.
 *
 * Both drag paths — the iOS long-press plugin (`mobileBlockDnd.ts`) and the ⠿
 * gutter handle's own HTML5 drag — resolve a drop
 * target with `blockDragGeometry.ts` and then commit through here, so a guard
 * added for one path can never be missing from the other.
 *
 * Every guard below is a failure that was actually observed on device:
 *
 *  - POSITIONS CAPTURED AT DRAG START GO STALE. Anything that edits the doc
 *    mid-drag (a host `setContent` from a sync pull, the trailing-paragraph
 *    plugin, autocorrect) shifts them. The caller passes the range it believes
 *    in and this refuses to act unless that range is still exactly one node.
 *  - `Transform.insert` DOES NOT FAIL ON AN INVALID POSITION. ProseMirror's
 *    Fitter silently unwraps a node that does not fit where it lands and merges
 *    its inline content into the surrounding textblock — which is what "my
 *    heading stopped being a heading after I dropped it" looks like. So the
 *    target's parent is asked, through the schema, whether it can hold the node
 *    THERE, the NODE is moved rather than a re-fitted slice, and the result is
 *    compared against the original before anything is dispatched.
 *  - A LIST ITEM PULLED OUT TO THE TOP LEVEL IS WRAPPED, BY US. The document
 *    cannot hold a bare list item; it gets a fresh list of the type (and attrs)
 *    it came out of — again asked of the schema, never assumed. And a list it
 *    was the only item of is removed whole, because an empty list is not a
 *    document the serializer can round-trip.
 *  - A DROP BACK AT THE SOURCE IS A TRUE NO-OP: no transaction, so no history
 *    entry, no change notification, and no `change` message to the host.
 *  - FRONT MATTER IS PINNED TO THE TOP. `---` only means front matter at the
 *    very start of a file, so a block dropped above it — or the block itself
 *    dragged down — would serialize metadata into the middle of the note, where
 *    the next open reads it back as a thematic break plus a setext heading and
 *    the values get prose-escaped. The schema says the same thing (the doc's
 *    content is `frontmatter? block+`), but ProseMirror does not enforce a
 *    content expression on every transform, so the guard belongs here too —
 *    this is the one place a block drag becomes a document change, for both
 *    drag paths.
 */
import type { Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { FRONTMATTER_NODE } from '@futo-notes/editor/milkdown-compat';

export interface BlockMoveRange {
  /** Position immediately before the dragged node. */
  from: number;
  /** Position immediately after it (`from + node.nodeSize`). */
  to: number;
}

/**
 * True when dropping at `targetPos` would be a no-op for the block occupying
 * `range` — landing on or inside its own span, including exactly either edge
 * (which is where "dropped where it started" lands once mapped through the
 * deletion). `moveBlock` refuses it below; both drag paths' indicator/haptic
 * layer (`mobileBlockDnd.ts`, `blockDropIndicator.ts`) call this too, so a
 * drop that would do nothing draws no line and ticks no haptic in the first
 * place, rather than only being silently refused on release.
 */
export function isNoOpDrop(range: BlockMoveRange, targetPos: number): boolean {
  return targetPos >= range.from && targetPos <= range.to;
}

/**
 * Moves the node at `range` so it starts at `targetPos`, as ONE transaction.
 * Returns true only when a transaction was dispatched — the callers use that
 * to decide whether the drop earned its haptic.
 */
export function moveBlock(
  view: ProseView,
  range: BlockMoveRange,
  targetPos: number,
  /** Runs on the move transaction just before dispatch — used to clear the
   * drag decoration in the SAME transaction, so the source block is never
   * drawn dimmed for a frame at its new position. */
  beforeDispatch?: (tr: Transaction) => void,
): boolean {
  const { from: srcStart, to: srcEnd } = range;

  if (isNoOpDrop(range, targetPos)) return false;

  const beforeDoc = view.state.doc;
  const node = beforeDoc.nodeAt(srcStart);
  // Not exactly one node any more — refuse to guess.
  if (!node || srcStart + node.nodeSize !== srcEnd) return false;
  // The front matter block never moves (see the header note).
  if (node.type.name === FRONTMATTER_NODE) return false;

  const source = beforeDoc.resolve(srcStart);
  const container = source.parent;
  const topLevel = source.depth === 0;
  // The only item of a list takes the list with it (see the header note).
  let deleteFrom = srcStart;
  let deleteTo = srcEnd;
  if (!topLevel && container.childCount === 1) {
    deleteFrom = source.before();
    deleteTo = source.after();
    if (targetPos >= deleteFrom && targetPos <= deleteTo) return false;
  }

  let tr = view.state.tr.delete(deleteFrom, deleteTo);
  const mappedTarget = tr.mapping.map(targetPos);
  const target = tr.doc.resolve(mappedTarget);
  const index = target.index();
  // Nothing moves above the front matter. Position 0 is the only boundary that
  // could, and only when front matter is what currently sits there.
  if (mappedTarget === 0 && tr.doc.firstChild?.type.name === FRONTMATTER_NODE) return false;

  // The same rule the resolver applies (blockDragGeometry.ts): a node lands in
  // a gap of the document, or of a container of the kind it came out of —
  // never inside some other block that merely happens to accept it. Positions
  // are re-checked here because the ones the caller resolved may have moved.
  const intoDoc = target.depth === 0;
  if (!intoDoc && (topLevel || target.parent.type !== container.type)) return false;

  let inserted = node;
  if (!target.parent.canReplaceWith(index, index, node.type)) {
    // The gap cannot hold the node itself; it may hold a list of its kind.
    if (topLevel || !target.parent.canReplaceWith(index, index, container.type)) return false;
    inserted = container.type.create(container.attrs, node);
  }

  tr = tr.insert(mappedTarget, inserted);
  // `insert` puts the node so it STARTS at mappedTarget, so no re-mapping.
  const moved = tr.doc.nodeAt(mappedTarget);
  if (!moved || !moved.sameMarkup(inserted) || !moved.content.eq(inserted.content)) return false;
  if (tr.doc.eq(beforeDoc)) return false;

  beforeDispatch?.(tr);
  view.dispatch(tr);
  return true;
}
