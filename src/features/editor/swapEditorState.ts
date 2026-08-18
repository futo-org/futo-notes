import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { tableFocusSyncEffect } from './table/interactiveTableEditor';

// State fields that learn about focus from focus EVENTS are seeded by `create()`, which
// cannot see the view: a state installed into a FOCUSED editor believes it is unfocused
// until the next real focus/blur. Every such field registers its sync here so the
// invariant lives with the state swap instead of at each call site.
const focusSeededFieldSyncs = [tableFocusSyncEffect];

/**
 * Install a whole new editor state, as opening a note does (swapping the state rather
 * than editing the document leaves no undo entry), and re-sync the focus-seeded fields
 * from the live view. Without that correction a note reopened with the caret inside a
 * table rendered the unfocused table widget until an unrelated focus event arrived.
 */
export function swapEditorState(view: EditorView, state: EditorState): void {
  view.setState(state);
  view.dispatch({ effects: focusSeededFieldSyncs.map((sync) => sync(view)) });
}
