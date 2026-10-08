/*
 * The one place a block drag turns into a document change.
 *
 * Both drag gestures — the native shells' long press (`mobileBlockDnd.ts`) and
 * the desktop ⠿ handle (`handleBlockDrag.ts`) — run through one drag session
 * (`blockDragSession.ts`) that resolves a drop target with
 * `blockDragGeometry.ts` and commits through here, so a guard added for one
 * gesture can never be missing from the other.
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
 *  - ONLY TOP-LEVEL BLOCKS MOVE, AND ONLY BETWEEN TOP-LEVEL BLOCKS. A drag
 *    lifts the whole top-level block containing the press (a list, never one
 *    of its items), so a source or a target below the top level is refused
 *    rather than reshaped.
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
 * deletion). `moveBlock` refuses it below; the drag session's indicator/haptic
 * layer (`blockDragSession.ts`) calls this too, so a
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
   * drawn dimmed for a frame at its new position, and to place the selection.
   * `movedTo` is where the moved node now starts in `tr.doc`. */
  beforeDispatch?: (tr: Transaction, movedTo: number) => void,
): boolean {
  const { from: srcStart, to: srcEnd } = range;

  if (isNoOpDrop(range, targetPos)) return false;

  const beforeDoc = view.state.doc;
  const node = beforeDoc.nodeAt(srcStart);
  // Not exactly one node any more — refuse to guess.
  if (!node || srcStart + node.nodeSize !== srcEnd) return false;
  // The front matter block never moves (see the header note).
  if (node.type.name === FRONTMATTER_NODE) return false;

  // Only a top-level block moves (see the header note).
  if (beforeDoc.resolve(srcStart).depth !== 0) return false;

  let tr = view.state.tr.delete(srcStart, srcEnd);
  const mappedTarget = tr.mapping.map(targetPos);
  const target = tr.doc.resolve(mappedTarget);
  const index = target.index();
  // Nothing moves above the front matter. Position 0 is the only boundary that
  // could, and only when front matter is what currently sits there.
  if (mappedTarget === 0 && tr.doc.firstChild?.type.name === FRONTMATTER_NODE) return false;

  // The same rule the resolver applies (blockDragGeometry.ts): a node lands in
  // a gap of the document — never inside some other block that merely happens
  // to accept it. Positions are re-checked here because the ones the caller
  // resolved may have moved.
  if (target.depth !== 0) return false;
  if (!target.parent.canReplaceWith(index, index, node.type)) return false;

  tr = tr.insert(mappedTarget, node);
  // `insert` puts the node so it STARTS at mappedTarget, so no re-mapping.
  const moved = tr.doc.nodeAt(mappedTarget);
  if (!moved || !moved.sameMarkup(node) || !moved.content.eq(node.content)) return false;
  if (tr.doc.eq(beforeDoc)) return false;

  beforeDispatch?.(tr, mappedTarget);
  view.dispatch(tr);
  return true;
}
