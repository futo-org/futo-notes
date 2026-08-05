import { EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { cursorOnTappedRow } from './caretRow';

const REACH_IN_LINES = 2;

export interface BlankSpacePoint {
  /** Client coordinates. */
  x: number;
  y: number;
  /** Top edge of the note's surface, owned by the shell. Applies at every x. */
  topLimit: number;
}

/** → docs/spec/editor.md. `null` means the point is a click away from the note. */
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

  // posAtCoords discards x and answers a document end for any y outside the text,
  // so clamp into the nearest line. The floor is the content box, not
  // coordsAtPos(0): a `display: none` header tag block has no coords at all.
  const onLineY = Math.min(Math.max(at.y, content.top + 1), textBottom - 1);
  const beyondReachBelow = at.y > textBottom + reach;
  const pos = beyondReachBelow
    ? view.state.doc.length
    : view.posAtCoords({ x: at.x, y: onLineY }, false);

  // No coords means every candidate sits in a hidden tag block, where a caret
  // would reveal the markup.
  if (view.coordsAtPos(pos) === null) return null;

  return beyondReachBelow ? EditorSelection.cursor(pos) : cursorOnTappedRow(view, pos, onLineY);
}
