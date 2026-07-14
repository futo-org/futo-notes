import { hasFileSystem } from '$lib/platform';
import { sanitizeFilename, validateTitle } from '$lib/rules';

import { shouldWriteNoteToDisk } from './noteSessionChanges';
import { updateNote } from './notes.svelte';

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
  showTitleWarning: (message: string) => void;
}

export function createNotePersistence(options: CreateNotePersistenceOptions) {
  return async function saveNote(): Promise<boolean> {
    const noteId = options.getNoteId();
    const editorContent = options.getEditorContent();
    if (!hasFileSystem || editorContent === undefined || noteId === null) return false;

    try {
      const state = options.getState();
      const newTitle = state.title.trim() || 'Untitled';
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
        }) ||
        options.hasDuplicateTitle(newTitle)
      ) {
        return false;
      }

      const result = await updateNote(
        newId,
        newTitle,
        editorContent,
        state.originalId ?? undefined,
      );
      options.clearPendingFolder();
      options.onSaved({
        id: result.id,
        title: newTitle,
        content: editorContent,
        savedOriginalId: state.originalId,
      });
      return true;
    } catch (error) {
      console.warn('Failed to save note:', error);
      return false;
    }
  };
}
