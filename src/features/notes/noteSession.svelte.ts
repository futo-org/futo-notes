import { hasFileSystem } from '$lib/platform';
import { idLeaf } from '$lib/platform/pathSafety';
import { notifySaved } from '$features/sync/autoSync';
import { createNoteSaveQueue } from './noteSaveQueue';
import { createNoteTitleController } from './createNoteTitleController.svelte';
import { createNotePersistence, titleSaveRefusal } from './createNotePersistence';
import { createNoteLoader } from './createNoteLoader';
import {
  editorHasUnseenChanges,
  hasDuplicateNoteTitle,
  titleHasUnsavedEdit,
} from './noteSessionChanges';
import { deleteNote, getNoteById, readNote, recordSaveIdentityChange } from './notes.svelte';
import type { NoteSession, NoteSessionDeps } from './noteSessionContract';

export type { NoteSession, NoteSessionDeps } from './noteSessionContract';

interface NoteSessionStatePatch {
  loading?: boolean;
  originalId?: string | null;
  savedTitle?: string;
  title?: string;
  createdNoteId?: string;
}

const TITLE_SAVE_DEBOUNCE_MS = 10_000;

/*
 * The open note as the shell shows it: its title. The editor owns the body. Its
 * attachment says which note is open (the session follows `followEditorNote`) and what its
 * body was last saved as (`savedContent` reads it), and its host saves the body. The
 * session saves only the title, and counts edits for sync (`editVersion`).
 */
// eslint-disable-next-line max-lines-per-function -- One Svelte rune factory owns the open note's facts and its title save.
export function createNoteSession(deps: NoteSessionDeps): NoteSession {
  let title = $state('');
  let originalId: string | null = $state(null);
  let savedTitle = $state('');
  let loading = $state(false);
  const savedContent = (): string => deps.getEditorSavedSource() ?? '';
  let editVersion = 0;
  let lastEditTime = 0;
  /** The note this session created for New note (createNoteLoader), until it is renamed:
   *  leaving it with an empty body deletes it, so nothing is left behind. */
  let createdNoteId: string | null = null;
  /** The note the newest switch handed the editor (`openLeavingUntouched`). */
  let newestOpenedNoteId: string | null = null;
  /* The text a focused title field keeps after a commit moved `title` (see showCommittedTitle). */
  let heldFieldTitle = $state<string | null>(null);

  let suppressSaveOnChange = false;

  function patchState(patch: NoteSessionStatePatch): void {
    if (patch.title !== undefined) title = patch.title;
    if (patch.savedTitle !== undefined) savedTitle = patch.savedTitle;
    if (patch.originalId !== undefined) {
      originalId = patch.originalId;
      heldFieldTitle = null;
    }
    if (patch.loading !== undefined) loading = patch.loading;
    if (patch.createdNoteId !== undefined) createdNoteId = patch.createdNoteId;
  }

  function resetSessionState(): void {
    title = '';
    heldFieldTitle = null;
    originalId = null;
    savedTitle = '';
    loading = false;
  }

  const hasDuplicateTitle = (value: string) =>
    hasDuplicateNoteTitle(value, deps.getNotes(), originalId, deps.getPendingFolder?.() ?? null);

  const titleController = createNoteTitleController({
    setTitle: (value) => {
      if (value === (heldFieldTitle ?? title)) return;
      heldFieldTitle = null;
      title = value;
    },
    hasDuplicateTitle,
    scheduleSave: () => debouncedSave(),
    flushSave: () => void saveQueue.flush().catch(() => {}),
    focusEditor: deps.focusEditor,
    getTextarea: deps.getTitleTextarea,
  });
  const saveNote = createNotePersistence({
    getEditorNoteId: deps.getEditorNoteId,
    getState: () => ({ title, originalId, savedTitle }),
    hasDuplicateTitle,
    isLoading: () => loading,
    showTitleWarning: (message) => titleController.showWarning(message, null),
    saveBody: deps.saveEditorNote,
    renameNote: deps.renameEditorNote,
    onTitleSaved: (requestedTitle) => {
      if (title === requestedTitle) showCommittedTitle(savedTitle);
    },
  });

  /**
   * The editor's attachment now holds `toId`: a rename's final id, the copy a save parked
   * the draft in (`keepsOriginal`) — whichever save it was: the host's timer, a
   * checkpoint, the close or this session's rename — or where a store workflow moved it
   * (a move, a sync relocation). The session never decides the id itself; it follows
   * here. The title is the note's name, except a title the user typed and has not saved
   * yet: the save takes it now, renaming the note from where it went (a warning it had,
   * a duplicate in the old folder, is stale). One the save refuses gives way, keeping
   * its warning while the field still shows it.
   */
  function followEditorNote(fromId: string, toId: string, keepsOriginal: boolean): void {
    if (fromId !== originalId) return;
    const typedTitle = titleHasUnsavedEdit(title, savedTitle);
    const tabShowsIt = deps.getNoteId() === fromId;
    originalId = toId;
    savedTitle = getNoteById(toId)?.title ?? idLeaf(toId);
    if (typedTitle && !titleSaveRefusal(title, hasDuplicateTitle)) {
      titleController.clearWarning();
      saveQueue.resume();
    } else {
      showCommittedTitle(savedTitle);
      if (heldFieldTitle === null) titleController.clearWarning();
    }
    // Renamed, moved or parked: no longer the untouched note New note created.
    createdNoteId = null;
    if (!keepsOriginal) {
      recordSaveIdentityChange(fromId, toId);
      deps.onNoteRenamed(fromId, toId);
      return;
    }
    // After a park the original still exists, so only the tab showing it moves to the
    // copy (a null source retargets the active tab). A park inside a note switch's own
    // close lands after the tab moved to the destination: the user is leaving, so no
    // tab follows.
    if (tabShowsIt) deps.onNoteRenamed(null, toId);
  }

  /** A save the editor's host made wrote the note (DesktopEditor `onsaved`). */
  function editorSaved(): void {
    notifySaved();
  }

  let persistenceTail: Promise<void> = Promise.resolve();

  /* Notes a local rename, move, or folder workflow relinked since the last
   * persistence step. Renaming a note the open note links to — or the open
   * note itself, when it links to itself — rewrites the open note's file
   * behind the editor (the store suppresses the watcher for its own writes).
   * Every persistence step settles these first, so the session's baseline
   * describes the file again before anything saves or reads it. */
  const relinkedIds = new Set<string>();

  function noteRelinked(ids: readonly string[]): void {
    for (const id of ids) relinkedIds.add(id);
    // An idle editor shows the rewritten link at once; a save queued behind a
    // locked workflow settles it before it writes.
    void serializePersistence(async () => {});
  }

  async function settleRelinks(): Promise<void> {
    const id = originalId;
    const openNoteRelinked = id !== null && relinkedIds.has(id);
    relinkedIds.clear();
    // A note being loaded is read afresh by the load itself.
    if (!openNoteRelinked || loading) return;
    let fresh: string;
    try {
      fresh = await readNote(id);
    } catch (error) {
      console.warn('Failed to read the relinked open note:', error);
      return;
    }
    const saved = savedContent();
    if (originalId !== id || loading || fresh === saved) return;
    if ((deps.getEditorContent() ?? saved) === saved) {
      // The rewrite is the user's own action, so it is adopted even into a
      // focused editor; the title is not the rewrite's to touch.
      adoptContent();
      return;
    }
    // Typing landed while the workflow committed. It is kept: the host moved its
    // baseline to the file with the rewrite, so its next save writes the draft
    // over it — a save, not a conflict. The draft keeps the link text the user sees.
    saveQueue.resume();
  }

  function serializePersistence<T>(operation: () => Promise<T>): Promise<T> {
    // Not an async wrapper: with nothing to settle the operation starts in the
    // same tick it always did.
    const step = (): Promise<T> =>
      relinkedIds.size > 0 ? settleRelinks().then(operation, operation) : operation();
    const run = persistenceTail.then(step, step);
    persistenceTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const saveQueue = createNoteSaveQueue({
    save: () => serializePersistence(saveNote),
    hasUnseenChanges: hasUnseenEditorChanges,
  });

  /* The editor reports the outgoing note's last coalesced change as it lets go of it;
   * when the session has already moved off that note, it is not an edit of the one it
   * now holds. (A note switch hands the editor over before moving, so its own change
   * report is the outgoing note's last edit.) */
  function openInEditor(noteId: string | null): void {
    suppressSaveOnChange = true;
    try {
      void deps.openEditorNote(noteId, deps.isVaultLocked?.() ?? false);
    } finally {
      suppressSaveOnChange = false;
    }
  }

  /* Leaving the note this session created, untouched — never renamed (a rename clears
   * `createdNoteId`) and its body empty (note-actions.md) — deletes it once the editor has
   * let go of it. The body is read from the editor, which still holds it: the coalesced
   * change of a last keystroke may not have reached `debouncedSave` yet. An editor holding
   * no note (mid-switch, it shows none) says nothing about it, so the note stays, as it
   * does when the open fails. While the vault is locked the note left keeps no unsaved
   * text: no save can succeed (flushBeforeLeaving). A newer switch back to it, made while
   * this one was in flight, keeps it. */
  async function openLeavingUntouched(noteId: string | null): Promise<void> {
    newestOpenedNoteId = noteId;
    const abandoned =
      createdNoteId !== null && createdNoteId !== noteId && deps.getEditorContent() === ''
        ? createdNoteId
        : null;
    await deps.openEditorNote(noteId, deps.isVaultLocked?.() ?? false);
    if (createdNoteId !== newestOpenedNoteId) createdNoteId = null;
    if (abandoned === null || abandoned === newestOpenedNoteId) return;
    void deleteNote(abandoned).then(
      () => deps.onNoteDeleted?.(abandoned),
      (error) => console.warn('Failed to delete an untouched new note:', error),
    );
  }

  const noteLoader = createNoteLoader({
    flushSave: flushBeforeLeaving,
    getEditorNoteId: deps.getEditorNoteId,
    getPendingFolder: () => deps.getPendingFolder?.() ?? null,
    onNoteRenamed: deps.onNoteRenamed,
    openNote: openLeavingUntouched,
    getNoteBody: deps.getNoteBody,
    focusEditor: deps.focusEditor,
    autoResizeTitle: titleController.autoResizeTextarea,
    clearTitleWarning: titleController.clearWarning,
    patchState,
    resetState: resetSessionState,
  });

  /**
   * An edit: the editor's coalesced report of a body edit, or a title edit. A body edit
   * saves nothing here — the editor's host saves it on its own timer — it only moves what
   * sync and the outside-change coordinator read. The editor reports only edits its
   * engine applied, never a load or reload, so an adopted outside change is not one.
   */
  function recordEdit(): boolean {
    if (suppressSaveOnChange) return false;
    if (loading || !hasFileSystem || deps.getNoteId() === null) return false;
    lastEditTime = Date.now();
    editVersion++;
    return true;
  }

  /** A title edit, which also arms the title's rename. */
  function debouncedSave(): void {
    if (recordEdit()) saveQueue.schedule(TITLE_SAVE_DEBOUNCE_MS);
  }

  // A failed save holds the user on the note (editor.md), but while the vault is
  // locked no save can succeed, so leaving discards the unsaved text instead.
  async function flushBeforeLeaving(): Promise<void> {
    try {
      await saveQueue.flush();
    } catch (error) {
      if (!deps.isVaultLocked?.()) throw error;
    }
  }

  function hasUnseenEditorChanges(): boolean {
    if (loading || !hasFileSystem) return false;
    if (deps.getNoteId() === null && originalId === null && !title) return false;
    return editorHasUnseenChanges({
      editorContent: deps.getEditorContent(),
      savedContent: savedContent(),
      title,
      savedTitle,
    });
  }

  async function runWithSaveLock<T>(operation: () => Promise<T>): Promise<T> {
    await saveQueue.flush();
    return serializePersistence(operation);
  }

  function isDirty(): boolean {
    if (!originalId) return false;
    return saveQueue.isPending() || hasUnseenEditorChanges();
  }

  function adoptContent(): void {
    suppressSaveOnChange = true;
    try {
      deps.reloadEditorNote();
    } finally {
      suppressSaveOnChange = false;
    }
  }

  /**
   * Re-hands the open note to an editor that just mounted.
   *
   * An editor component mounts empty; under a session that still holds the
   * note that is a blank page over a file with content. Today only a dev hot
   * reload remounts it; a `{#key}` or `{#if}` around the editor would do it in
   * production, which is exactly why the recovery lives here rather than in a
   * comment. The shell calls it per mount (app/createEditorMountReattach.ts).
   * → docs/spec/editor/cursor/a-note-the-editor-cannot-hold.md
   */
  function reattachEditor(): void {
    openInEditor(originalId);
  }

  /**
   * While the title field is focused only the user's typing changes it
   * (list.md). A title the app commits meanwhile — a save that trimmed what was
   * typed, a sync rename — becomes `title` at once, so saves never request the
   * stale text, but the field keeps showing what it had until blur. Typing
   * first replaces both.
   */
  function showCommittedTitle(committed: string): void {
    if (committed !== title && document.activeElement === deps.getTitleTextarea()) {
      heldFieldTitle ??= title;
    }
    title = committed;
  }

  function handleTitleBlur(): void {
    // A window switch blurs the field but leaves it the active element.
    if (heldFieldTitle !== null && document.activeElement !== deps.getTitleTextarea()) {
      heldFieldTitle = null;
      titleController.clearWarning();
    }
    titleController.handleBlur();
  }

  function seedOpenNote(id: string): void {
    originalId = id;
    title = id;
    heldFieldTitle = null;
    savedTitle = id;
    openInEditor(id);
    deps.setPrevNoteId(id);
    titleController.clearWarning();
    deps.navigate(`/note/${encodeURIComponent(id)}`);
  }

  function cancelAndClear(): void {
    noteLoader.cancel();
    saveQueue.cancelPending();
    titleController.clearWarning();
    // The note went away (deleted here or elsewhere): there is nothing left to discard.
    createdNoteId = null;
    openInEditor(null);
    resetSessionState();
    deps.navigate('/');
  }

  return {
    get title() {
      return title;
    },
    get fieldTitle() {
      return heldFieldTitle ?? title;
    },
    get originalId() {
      return originalId;
    },
    get titleWarning() {
      return titleController.warning;
    },
    get loading() {
      return loading;
    },
    get editVersion() {
      return editVersion;
    },
    get lastEditTime() {
      return lastEditTime;
    },
    /** The title's save, or an edit the editor's host has not written yet. */
    get savePending() {
      return saveQueue.isPending() || !deps.isEditorIdle();
    },
    get savedContent() {
      return savedContent();
    },
    get dirty() {
      return isDirty();
    },
    get editorContent() {
      return deps.getEditorContent();
    },
    get editorFocused() {
      return deps.isEditorFocused();
    },
    get composing() {
      return deps.isComposing();
    },
    debouncedSave,
    editorEdited: () => void recordEdit(),
    resumeDraftPersistence: saveQueue.resume,
    flushSave: saveQueue.flush,
    checkpointEditor: deps.saveEditorNote,
    runWithSaveLock,
    loadNote: noteLoader.load,
    handleTitleInput: titleController.handleInput,
    setTitle: titleController.setTitle,
    handleTitleKeydown: titleController.handleKeydown,
    handleTitleBlur,
    handleTitleFocus: titleController.handleFocus,
    handleTitlePointerDown: titleController.handlePointerDown,
    seedOpenNote,
    cancelAndClear,
    applyExternalContent: () => deps.takeOutsideEditorChange(),
    reattachEditor,
    noteRelinked,
    followEditorNote,
    editorSaved,
  };
}
