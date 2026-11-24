/* The vault's note ids, delivered to the open note's engine (portable-core/wikilinks.md): it
 * answers one projection per wikilink whose resolution or label changed (a note added, removed
 * or renamed), and those lines are drawn again. */
import type { NoteIdChange } from '@futo-notes/editor/wasm-payloads';
import { drawLine } from './lineElements';
import type { EditorView } from './view';

/** Show what a note-id delivery to `view`'s engine changed. */
export function showNoteIdChange(view: EditorView, change: NoteIdChange): void {
  const model = view.lineModel();
  if (!model || change.revision !== view.revision()) return;
  const elements = view.lineElements();
  for (const projection of change.projections) {
    const [from, to] = model.applyBlocks(projection);
    for (let index = from; index < to; index++) drawLine(elements[index], model.lines[index]);
  }
  if (change.projections.length > 0) view.redraw();
}
