import type { EditorView } from '@codemirror/view';

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
 * Where the caret goes for a pointer landing in the blank space around the text,
 * or `null` when the point is a click away from the note.
 */
export function resolveBlankSpaceCaret(view: EditorView, at: BlankSpacePoint): number | null {
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
  const pos =
    at.y > textBottom + reach
      ? view.state.doc.length
      : view.posAtCoords(
          { x: at.x, y: Math.min(Math.max(at.y, content.top + 1), textBottom - 1) },
          false,
        );

  // A note that is nothing BUT a hidden tag block has no visible line to reach,
  // and every candidate lands in the markup the tag bar exists to replace — where
  // the caret reveals it and the next keystroke corrupts a tag.
  return view.coordsAtPos(pos) === null ? null : pos;
}
