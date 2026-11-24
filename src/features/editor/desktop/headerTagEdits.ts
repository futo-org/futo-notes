/* The tag bar's edits (docs/spec/editor/desktop/tags.md): the engine writes the note's header
 * tag block (`add_header_tag`, `remove_header_tag`), each edit one Undo step through the view's
 * input path, so saving and the idle signal follow it as they follow typing. The bar is app
 * chrome outside the editor: an edit there leaves the scroll where it is, and the engine carries
 * the note's caret and selection across it. */
import type { Applied } from '@futo-notes/editor/wasm-payloads';
import type { Engine } from './engine';
import type { EditorView } from './view';

/** Adds and removes the header tags of the one note it was made for: once another note, or the
 *  same note read again, is open, it writes nothing. */
export interface HeaderTagEdits {
  add(name: string): void;
  remove(tag: string): void;
}

/** The header tag edits of the note `engine` holds, shown in `view`; `edited` runs after each
 *  one that changed the note. */
export function createHeaderTagEdits(
  view: EditorView,
  engine: Engine,
  edited: () => void,
): HeaderTagEdits {
  const run = (edit: (current: Engine) => Applied | null): void => {
    if (view.currentEngine() !== engine) return;
    const before = engine.revision;
    view.run(edit, false);
    if (engine.revision !== before) edited();
  };
  return {
    add: (name) => run((current) => current.addHeaderTag(name)),
    remove: (tag) => run((current) => current.removeHeaderTag(tag)),
  };
}
