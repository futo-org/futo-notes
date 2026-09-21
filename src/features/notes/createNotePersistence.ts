import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { hasFileSystem } from '$lib/platform';
import { sanitizeFilename, validateTitle } from '$lib/rules';
import type { LocalizedMessage } from '$shared/localization';

import { normalizeTitleForPersistence, shouldWriteNoteToDisk } from './noteSessionChanges';
import type { ParkedDraftSnapshot } from './noteSession.svelte';
import { _applyLocalMutation, recordSaveIdentityChange, updateNote } from './notes.svelte';
import { titleValidationMessage } from './titleValidationMessage';

interface NotePersistenceState {
  originalId: string | null;
  savedContent: string;
  savedTitle: string;
  title: string;
}

/**
 * True while the session is mid-switch to another note: `originalId` may
 * already point at the note being opened while `title`/`savedContent` still
 * hold the outgoing note's data (createNoteLoader.load() flips loading
 * before reassigning originalId, then awaits the read). A save that runs in
 * this window would write the outgoing note's stale content under the
 * incoming note's id — refuse rather than straddle. The save queue's flush()
 * closes this window under normal operation; this is the belt-and-suspenders
 * backstop for any caller that reaches saveNote() while it is still open.
 */
type IsLoading = () => boolean;

interface SavedNoteState {
  content: string;
  id: string;
  savedOriginalId: string | null;
  requestedTitle: string;
  title: string;
}

interface CreateNotePersistenceOptions {
  clearPendingFolder: () => void;
  getEditorContent: () => string | undefined;
  getNoteId: () => string | null;
  getPendingFolder: () => string | null;
  getState: () => NotePersistenceState;
  hasDuplicateTitle: (title: string) => boolean;
  isLoading: IsLoading;
  onSaved: (state: SavedNoteState) => void;
  reconcileOpenNote: (id: string, parkedDraft: ParkedDraftSnapshot) => Promise<unknown>;
  showTitleWarning: (message: LocalizedMessage) => void;
}

export function createNotePersistence(options: CreateNotePersistenceOptions) {
  return async function saveNote(): Promise<boolean> {
    const noteId = options.getNoteId();
    const editorContent = options.getEditorContent();
    if (!hasFileSystem || editorContent === undefined) return false;
    // The session is between notes: title/savedContent may still be the
    // outgoing note's while originalId already points at the incoming one.
    // Never write in this window (see IsLoading above).
    if (options.isLoading()) return false;

    try {
      const state = options.getState();
      // Navigating Home clears the tab's note id before this queued save runs.
      if (noteId === null && state.originalId === null && !state.title) return false;
      const newTitle = normalizeTitleForPersistence(state.title);
      const blockingTitleIssue = validateTitle(newTitle).find((issue) => issue.kind !== 'empty');
      if (blockingTitleIssue) {
        options.showTitleWarning(titleValidationMessage(blockingTitleIssue.kind));
        return false;
      }

      let newId = sanitizeFilename(newTitle);
      if (state.originalId) {
        const slash = state.originalId.lastIndexOf('/');
        if (slash !== -1) newId = `${state.originalId.slice(0, slash + 1)}${newId}`;
      } else {
        const pendingFolder = options.getPendingFolder();
        if (pendingFolder) newId = `${pendingFolder}/${newId}`;
      }

      if (
        !shouldWriteNoteToDisk({
          savedTitle: state.savedTitle,
          newTitle,
          content: state.savedContent,
          newContent: editorContent,
        })
      ) {
        return false;
      }
      if (options.hasDuplicateTitle(newTitle)) {
        options.showTitleWarning({ path: 'notes.title.duplicate' });
        return false;
      }

      const result = await updateNote(newId, editorContent, {
        originalId: state.originalId ?? undefined,
        base: state.savedContent,
      });
      if (result.unappliedMutation) _applyLocalMutation(result.unappliedMutation);
      if (result.disposition === 'parked') {
        await options.reconcileOpenNote(result.id, { content: editorContent, title: state.title });
        return false;
      }

      options.clearPendingFolder();
      if (result.id !== state.originalId) recordSaveIdentityChange(state.originalId, result.id);
      const savedNote = result.unappliedMutation?.upserted.find(
        ({ note }) => note.id === result.id,
      )?.note;
      options.onSaved({
        id: result.id,
        title: savedNote?.title ?? newTitle,
        requestedTitle: state.title,
        content: editorContent,
        savedOriginalId: state.originalId,
      });
      return result.disposition !== 'converged';
    } catch (error) {
      console.warn('Failed to save note:', error);
      showGlobalToast({ path: 'notes.save.failedPending' });
      throw error;
    }
  };
}
