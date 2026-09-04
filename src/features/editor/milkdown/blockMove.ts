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
 *    in and this refuses to act unless that range is still exactly one
 *    top-level node.
 *  - `Transform.insert` DOES NOT FAIL ON AN INVALID POSITION. ProseMirror's
 *    Fitter silently unwraps a node that does not fit where it lands and merges
 *    its inline content into the surrounding textblock — which is what "my
 *    heading stopped being a heading after I dropped it" looks like. So the
 *    mapped target is required to still be a top-level gap, the NODE is moved
 *    rather than a re-fitted slice, and the result is compared against the
 *    original before anything is dispatched.
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
  /** Position immediately before the dragged top-level node. */
  from: number;
  /** Position immediately after it (`from + node.nodeSize`). */
  to: number;
}

/**
 * Moves the top-level node at `range` so it starts at `targetPos`, as ONE
 * transaction. Returns true only when a transaction was dispatched — the
 * callers use that to decide whether the drop earned its haptic.
 */
export function moveTopLevelBlock(
  view: ProseView,
  range: BlockMoveRange,
  targetPos: number,
  /** Runs on the move transaction just before dispatch — used to clear the
   * drag decoration in the SAME transaction, so the source block is never
   * drawn dimmed for a frame at its new position. */
  beforeDispatch?: (tr: Transaction) => void,
): boolean {
  const { from: srcStart, to: srcEnd } = range;

  // Dropping onto or inside the source's own range (including exactly either
  // edge, which is where "dropped where it started" lands once mapped through
  // the deletion) is the no-op case.
  if (targetPos >= srcStart && targetPos <= srcEnd) return false;

  const beforeDoc = view.state.doc;
  const node = beforeDoc.nodeAt(srcStart);
  // Not exactly one top-level node any more — refuse to guess.
  if (!node || srcStart + node.nodeSize !== srcEnd) return false;
  if (beforeDoc.resolve(srcStart).depth !== 0) return false;
  // The front matter block never moves (see the header note).
  if (node.type.name === FRONTMATTER_NODE) return false;

  let tr = view.state.tr.delete(srcStart, srcEnd);
  const mappedTarget = tr.mapping.map(targetPos);
  // The boundary stopped being a top-level gap once the source was removed;
  // inserting there would coerce the node's type.
  if (tr.doc.resolve(mappedTarget).depth !== 0) return false;
  // …and nothing moves above it. Position 0 is the only boundary that could,
  // and only when front matter is what currently sits there.
  if (mappedTarget === 0 && tr.doc.firstChild?.type.name === FRONTMATTER_NODE) return false;

  tr = tr.insert(mappedTarget, node);
  // `insert` puts the node so it STARTS at mappedTarget, so no re-mapping.
  const moved = tr.doc.nodeAt(mappedTarget);
  if (!moved || !moved.sameMarkup(node) || !moved.content.eq(node.content)) return false;
  if (tr.doc.eq(beforeDoc)) return false;

  beforeDispatch?.(tr);
  view.dispatch(tr);
  return true;
}
