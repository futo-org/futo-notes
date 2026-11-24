import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { hasFileSystem } from '$lib/platform';
import { validateTitle } from '$lib/rules';
import type { LocalizedMessage } from '$shared/localization';

import { normalizeTitleForPersistence } from './noteSessionChanges';
import { titleValidationMessage } from './titleValidationMessage';

interface NotePersistenceState {
  originalId: string | null;
  savedTitle: string;
  title: string;
}

interface CreateNotePersistenceOptions {
  /** The note the editor holds; null while it holds none. */
  getEditorNoteId: () => string | null;
  getState: () => NotePersistenceState;
  hasDuplicateTitle: (title: string) => boolean;
  /** A note switch is opening the next note; nothing saves until it has. */
  isLoading: () => boolean;
  /** The note's name now stands for `requestedTitle`, the title this save took. */
  onTitleSaved: (requestedTitle: string) => void;
  /** The editor writes the open note now (its host saves edits on its own timer too). */
  saveBody: () => Promise<void>;
  /** The editor saves the open note as `title` in its folder in one store workflow; it
   *  reports where the note landed (a rename's final id, or a parked copy) as it lands. */
  renameNote: (title: string) => Promise<void>;
  showTitleWarning: (message: LocalizedMessage) => void;
}

/** Why a save refuses `title` — invalid or a duplicate (list.md) — or null when it takes it. */
export function titleSaveRefusal(
  title: string,
  hasDuplicateTitle: (title: string) => boolean,
): LocalizedMessage | null {
  const normalized = normalizeTitleForPersistence(title);
  const issue = validateTitle(normalized).find((item) => item.kind !== 'empty');
  if (issue) return titleValidationMessage(issue.kind);
  return hasDuplicateTitle(normalized) ? { path: 'notes.title.duplicate' } : null;
}

/** The session's save: a typed title renames the note (the body saves with it), else the
 *  editor writes its draft now (no I/O when nothing changed). */
export function createNotePersistence(options: CreateNotePersistenceOptions) {
  return async function saveNote(): Promise<void> {
    // The editor's host holds the body; nothing attached means nothing to save.
    if (!hasFileSystem || options.getEditorNoteId() === null || options.isLoading()) return;

    const state = options.getState();
    // Every attached note has a file: a new note is created when it opens.
    if (state.originalId === null) return;
    /* A refused title never takes the body down with it (2026-10-20): the body
     * saves under the note's current name and the title waits, its warning up. */
    const refusal = titleSaveRefusal(state.title, options.hasDuplicateTitle);
    if (refusal) options.showTitleWarning(refusal);
    const newTitle = refusal ? state.savedTitle : normalizeTitleForPersistence(state.title);

    try {
      // The host names the note: `newTitle`, sanitized, in the folder it holds it in.
      if (newTitle !== state.savedTitle) await options.renameNote(newTitle);
      else await options.saveBody();
    } catch (error) {
      console.warn('Failed to save note:', error);
      showGlobalToast({ path: 'notes.save.failedPending' });
      throw error;
    }
    if (newTitle !== state.savedTitle) options.onTitleSaved(state.title);
  };
}
