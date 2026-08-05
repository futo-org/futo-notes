import { EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { cursorOnTappedRow } from './caretRow';

/** How far past the text, to the sides and below, still counts as reaching for it. */
const REACH_IN_LINES = 2;

export interface BlankSpacePoint {
  /** Pointer position, in client coordinates. */
  x: number;
  y: number;
  /** Top edge of the note's surface. The shell owns it: the strips stacked above
   *  the text are its layout, not the editor's. Applied at every x. */
  topLimit: number;
}

/**
 * The caret a pointer landing in the blank space around the text means, or `null`
 * when the point is a click away from the note. The row travels with it: a click
 * beside a WRAPPED row resolves to a wrap point, and a bare offset there draws
 * the caret one row below the click (→ `cursorOnTappedRow`).
 */
export function resolveBlankSpaceCaret(
  view: EditorView,
  at: BlankSpacePoint,
): SelectionRange | null {
  const content = view.contentDOM.getBoundingClientRect();
  const reach = view.defaultLineHeight * REACH_IN_LINES;

  if (at.x < content.left - reach || at.x > content.right + reach) return null;
  if (at.y < at.topLimit) return null;

  const lastLine = view.coordsAtPos(view.state.doc.length);
  const textBottom = lastLine ? lastLine.bottom : content.bottom;

  // posAtCoords answers an end of the note for any y outside the text, discarding
  // x, so clamp into the nearest line first. Clamp to the CONTENT BOX, not to
  // coordsAtPos(0): a hidden header tag block renders `display: none`, so its
  // positions have no coords at all.
  const onLineY = Math.min(Math.max(at.y, content.top + 1), textBottom - 1);
  const beyondReachBelow = at.y > textBottom + reach;
  const pos = beyondReachBelow
    ? view.state.doc.length
    : view.posAtCoords({ x: at.x, y: onLineY }, false);

  // A note that is nothing BUT a hidden tag block has no visible line to reach,
  // and every candidate lands in the markup the tag bar exists to replace — where
  // the caret reveals it and the next keystroke corrupts a tag.
  if (view.coordsAtPos(pos) === null) return null;

  return beyondReachBelow ? EditorSelection.cursor(pos) : cursorOnTappedRow(view, pos, onLineY);
}
