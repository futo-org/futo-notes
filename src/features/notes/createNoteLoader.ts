import { hasFileSystem } from '$lib/platform';
import { idLeaf } from '$lib/platform/pathSafety';
import { FALLBACK_TITLE } from '$lib/rules';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { markNoteSwitch } from '$shared/perf/noteSwitchTimeline';

import { createNote, deleteNote, getNoteById, noteExists } from './notes.svelte';

interface NoteLoadPatch {
  loading?: boolean;
  originalId?: string | null;
  savedTitle?: string;
  title?: string;
  /** The note this open created; leaving it untouched deletes it again. */
  createdNoteId?: string;
}

interface CreateNoteLoaderOptions {
  autoResizeTitle: () => void;
  clearTitleWarning: () => void;
  flushSave: () => Promise<void>;
  focusEditor: () => void;
  /** The note the editor's host holds, as it reported it; null while it holds none. */
  getEditorNoteId: () => string | null;
  getNoteBody: () => HTMLElement | undefined;
  /** The folder a new note is created in. */
  getPendingFolder: () => string | null;
  onNoteRenamed: (fromId: string | null, toId: string) => void;
  patchState: (patch: NoteLoadPatch) => void;
  resetState: () => void;
  /** Hands the editor the note; settles once the editor holds it, and rejects when the
   *  editor could not (it keeps the note it had). */
  openNote: (noteId: string | null) => Promise<void> | void;
}

export function createNoteLoader(options: CreateNoteLoaderOptions) {
  let loadVersion = 0;

  /** A note created for a load a newer one overtook: no one saw it. */
  function deleteUnseen(id: string): void {
    void deleteNote(id).catch((error) => console.warn('Failed to delete a note:', error));
  }

  /**
   * The note `id` opens, created now when it has no file yet: a new note (`'new'`,
   * "Untitled" in the pending folder), or a missing wikilink target. The editor attaches
   * only a note on disk. A failed existence check rejects: never turn it into a create
   * that could resurrect a note deleted during sync. Null when a newer load took over
   * (the note made for it is deleted again: no one saw it).
   */
  async function noteToOpen(
    id: string,
    version: number,
  ): Promise<{ id: string; created: boolean } | null> {
    if (id !== 'new' && (await noteExists(id))) {
      return version === loadVersion ? { id, created: false } : null;
    }
    if (version !== loadVersion) return null;
    const folder = id === 'new' ? options.getPendingFolder() : null;
    const wantedId = id !== 'new' ? id : folder ? `${folder}/${FALLBACK_TITLE}` : FALLBACK_TITLE;
    let createdId: string;
    try {
      // The store picks a free id ("Untitled-1"); the mutation is applied here.
      createdId = (await createNote(wantedId, '')).id;
    } catch (error) {
      showGlobalToast({ path: 'notes.errors.createFailed' });
      throw error;
    }
    if (version === loadVersion) return { id: createdId, created: true };
    deleteUnseen(createdId);
    return null;
  }

  /**
   * Leaves the open note for `id`. The session keeps the outgoing note until the editor
   * holds the incoming one: its pending title saves first, then the editor closes it
   * (saving the body) and opens the next, and only then does the session describe that
   * note (its saved baseline is the editor's). A failed save or open rejects with the
   * session unchanged, so the tab goes back (createTabNoteTransition).
   */
  async function load(id: string | null): Promise<void> {
    const version = ++loadVersion;
    await options.flushSave();
    markNoteSwitch('saveFlushed');
    if (version !== loadVersion) return;

    if (!id) {
      await options.openNote(null);
      if (version !== loadVersion) return;
      options.clearTitleWarning();
      options.resetState();
      return;
    }
    if (!hasFileSystem) {
      options.patchState({ originalId: id !== 'new' ? id : null });
      return;
    }
    const target = await noteToOpen(id, version);
    if (target === null) return;

    options.patchState({ loading: true });
    try {
      // The load settles once the editor holds the note, so a tab's scroll restore
      // (createTabNoteTransition) lands on a laid-out note.
      await options.openNote(target.id);
    } finally {
      options.patchState({ loading: false });
    }
    if (version !== loadVersion) {
      // Overtaken while the editor opened it: the newer load moves the editor on.
      if (target.created) deleteUnseen(target.id);
      return;
    }

    // The note the host opened, as it names it: a stale row's "plan" opens "Plan".
    const openedId = options.getEditorNoteId() ?? target.id;
    const title = getNoteById(openedId)?.title || idLeaf(openedId);
    options.clearTitleWarning();
    options.patchState({
      originalId: openedId,
      title,
      savedTitle: title,
      createdNoteId: target.created ? openedId : undefined,
    });
    if (openedId !== id) options.onNoteRenamed(id === 'new' ? null : id, openedId);
    const noteBody = options.getNoteBody();
    if (noteBody) noteBody.scrollTop = 0;
    markNoteSwitch('contentApplied');
    requestAnimationFrame(() => {
      if (version !== loadVersion) return;
      options.autoResizeTitle();
      // Quick capture: a new note opens with the body focused (list/new-note.md).
      if (id === 'new') options.focusEditor();
    });
    markNoteSwitch('loadReturned');
  }

  function cancel(): void {
    loadVersion += 1;
  }

  return { load, cancel };
}
