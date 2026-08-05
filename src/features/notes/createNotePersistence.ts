import { hasFileSystem } from '$lib/platform';
import { sanitizeFilename, validateTitle } from '$lib/rules';

import { normalizeTitleForPersistence, shouldWriteNoteToDisk } from './noteSessionChanges';
import type { ParkedDraftSnapshot } from './noteSession.svelte';
import { _applyLocalMutation, recordSaveIdentityChange, updateNote } from './notes.svelte';

interface NotePersistenceState {
  originalId: string | null;
  savedContent: string;
  savedTitle: string;
  title: string;
}

interface SavedNoteState {
  content: string;
  id: string;
  savedOriginalId: string | null;
  title: string;
}

interface CreateNotePersistenceOptions {
  clearPendingFolder: () => void;
  getEditorContent: () => string | undefined;
  getNoteId: () => string | null;
  getPendingFolder: () => string | null;
  getState: () => NotePersistenceState;
  hasDuplicateTitle: (title: string) => boolean;
  onSaved: (state: SavedNoteState) => void;
  reconcileOpenNote: (id: string, parkedDraft: ParkedDraftSnapshot) => Promise<unknown>;
  showTitleWarning: (message: string) => void;
}

export function createNotePersistence(options: CreateNotePersistenceOptions) {
  return async function saveNote(): Promise<boolean> {
    const noteId = options.getNoteId();
    const editorContent = options.getEditorContent();
    if (!hasFileSystem || editorContent === undefined) return false;

    try {
      const state = options.getState();
      // Navigating Home clears the tab's note id before this queued save runs,
      // so the session is what says whether there is still a note to write.
      if (noteId === null && state.originalId === null) return false;
      const newTitle = normalizeTitleForPersistence(state.title);
      const blockingTitleIssue = validateTitle(newTitle).find((issue) => issue.kind !== 'empty');
      if (blockingTitleIssue) {
        options.showTitleWarning(blockingTitleIssue.message);
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
        options.showTitleWarning('A note with this name already exists');
        return false;
      }

      const result = await updateNote(newId, newTitle, editorContent, {
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
      options.onSaved({
        id: result.id,
        title: newTitle,
        content: editorContent,
        savedOriginalId: state.originalId,
      });
      return result.disposition !== 'converged';
    } catch (error) {
      console.warn('Failed to save note:', error);
      return false;
    }
  };
}
