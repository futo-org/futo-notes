import { EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * At a wrap point one offset draws in two places — end of a row, start of the
 * next — and only the association separates them. → docs/spec/editor.md
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
