/* Mod+Enter in a table's cell (portable-core/tables.md): the engine puts the caret on an empty
 * line after the table, moving to the line after it when that one is empty and otherwise
 * writing one. Enter at the row's end, Mod+Enter's way elsewhere, would end the table there. */
import { applyTableOutcome } from './applyTableOutcome';
import type { EditorView } from './view';

/** Leave the table whose cell holds the engine's selection; false, with nothing done, when the
 *  selection is in no cell. */
export function leaveTable(view: EditorView): boolean {
  return applyTableOutcome(view, (engine) => engine.tableKey('ModEnter'));
}
