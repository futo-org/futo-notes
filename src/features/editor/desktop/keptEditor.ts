/* What a dev hot reload keeps of the editor it remounts, for the new editor to show when it
 * reopens the same note: the engine's selection, whether the editor had focus, and the pane's
 * scroll. DesktopEditor.svelte calls it only behind `import.meta.hot`, so a release build drops it. */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { AttachedNote } from './attachedNote';
import { scrollerOf } from './paneScroll';
import type { EditorView } from './view';

/** Read while the editor is still in the page: Svelte removes its DOM before its teardown. */
export interface EditorFocusAndScroll {
  focused: boolean;
  scrollTop: number;
}

export interface KeptEditor extends EditorFocusAndScroll {
  noteId: string;
  /** The engine's selection, in display bytes. */
  selection: DisplayRange;
}

export function readEditorFocusAndScroll(view: EditorView): EditorFocusAndScroll {
  return {
    focused: view.dom.contains(document.activeElement),
    scrollTop: scrollerOf(view.dom).scrollTop,
  };
}

export function keepEditorState(
  view: EditorView,
  noteId: string,
  focusAndScroll: EditorFocusAndScroll,
): KeptEditor {
  return { noteId, selection: view.selection.bytes(), ...focusAndScroll };
}

/** Show `kept` on the note just attached, if it is that note's. Focus comes back only to an
 *  editor that had it, and never from another control that has it now. */
export function restoreKeptEditor(
  view: EditorView,
  attached: AttachedNote,
  kept: KeptEditor,
): void {
  if (!view.dom.isConnected || kept.noteId !== attached.noteId) return;
  try {
    attached.engine.placeSelection(kept.selection, 'Forward');
    view.selection.reset(attached.engine);
  } catch (error) {
    console.warn('selection refused:', error);
  }
  const focusIsFree = !document.activeElement || document.activeElement === document.body;
  if (kept.focused && focusIsFree) view.focus();
  scrollerOf(view.dom).scrollTop = kept.scrollTop;
}
