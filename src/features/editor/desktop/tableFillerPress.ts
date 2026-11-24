/* A press on a filler, the box a short table row is drawn with for a cell it lacks
 * (tableRowElements.ts): the engine gives the row its missing cells up to that column, one
 * Undo step, and puts the caret in it. The filler holds no text, so the hit-test would put the
 * caret in the row's last real cell instead. */
import { applyTableOutcome } from './applyTableOutcome';
import { tableColumnParts, tableFillerOf } from './tableRowElements';
import type { EditorView } from './view';

/** Enter the cell a pressed filler stands for; false for any other press, a Shift press and a
 *  note that cannot be edited, which the pointer takes as usual. */
export function pressTableFiller(view: EditorView, event: MouseEvent): boolean {
  if (event.shiftKey || !view.dom.isContentEditable) return false;
  const filler = tableFillerOf(event.target instanceof Node ? event.target : null);
  const row = filler?.parentElement;
  if (!filler || !row) return false;
  const column = tableColumnParts(row).indexOf(filler);
  if (!view.hasFocus()) view.focus(false);
  const at = view.offsetOf(row, 0);
  return applyTableOutcome(view, (engine) => engine.enterTableCell(at, column));
}
