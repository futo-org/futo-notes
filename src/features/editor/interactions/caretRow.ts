import { EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * A wrap point is ONE position the caret can be drawn in two places — the end of
 * a row or the start of the next — and only the association tells them apart.
 * The pointer's own y picks. Every path that resolves a caret from a pointer owes
 * its answer this bit, or the caret appears a row below an otherwise correct
 * click. → docs/spec/editor.md
 */
export function cursorOnTappedRow(
  view: EditorView,
  position: number,
  clientY: number,
): SelectionRange {
  const before = view.coordsAtPos(position, -1);
  const after = view.coordsAtPos(position, 1);
  if (!before || !after || before.top === after.top) return EditorSelection.cursor(position);
  return EditorSelection.cursor(position, clientY < after.top ? -1 : 1);
}
