import type { NotePreview } from '$shared/types/note';

/* The editor, as the session drives it: it holds the open note and saves it, and tells
 * the session where the note went (`followEditorNote`) and when a save wrote it
 * (`editorSaved`). */
export interface NoteSessionDeps {
  /** The draft the editor holds; undefined while it holds no note. */
  getEditorContent: () => string | undefined;
  /** The source the open note held when the editor's draft last matched it. */
  getEditorSavedSource: () => string | undefined;
  /** The note the editor's host holds, as it reported it; null while it holds none. */
  getEditorNoteId: () => string | null;
  /** Every edit the editor holds is written (or a test hold declined it). */
  isEditorIdle: () => boolean;
  /** Re-reads the open note from disk into the editor (a backlink rewrite adopted). */
  reloadEditorNote: () => void;
  /** Takes an outside change into the open, clean note: in place when its host offers it,
   *  else read back from disk. */
  takeOutsideEditorChange: () => void;
  /**
   * Attaches the editor to `noteId` (null: no note), then releases the note it held:
   * saved, or with `discardUnsaved` dropped. Settles once the editor holds it; rejects
   * when it could not, still holding the old one.
   */
  openEditorNote: (noteId: string | null, discardUnsaved: boolean) => Promise<void> | void;
  /** Writes the open note now. Rejects when the save fails. */
  saveEditorNote: () => Promise<void>;
  /** Saves the open note as `title` in its folder in one store workflow (the title's
   *  rename); the editor's host names the destination. */
  renameEditorNote: (title: string) => Promise<void>;
  focusEditor: () => void;
  isEditorFocused: () => boolean;
  isComposing: () => boolean;
  getNotes: () => NotePreview[];
  getNoteBody: () => HTMLElement | undefined;
  getTitleTextarea: () => HTMLTextAreaElement | undefined;
  getNoteId: () => string | null;
  setPrevNoteId: (id: string) => void;
  /** The folder a new note on the active tab is created in. */
  getPendingFolder?: () => string | null;
  /** A null `fromId` moves the active tab: to a note created for it, or to a parked copy. */
  onNoteRenamed: (fromId: string | null, toId: string) => void;
  /** A note the session created and deleted again, untouched: drop it from the tabs. */
  onNoteDeleted?: (id: string) => void;
  navigate: (path: string) => void;
  /** The desktop vault refuses writes: nothing can be saved for the rest of the launch. */
  isVaultLocked?: () => boolean;
}

export interface NoteSession {
  readonly title: string;
  /** What the title field shows: `title`, unless a commit landed while it was focused (list.md). */
  readonly fieldTitle: string;
  readonly originalId: string | null;
  readonly titleWarning: string;
  readonly loading: boolean;

  readonly editVersion: number;
  readonly lastEditTime: number;
  /** The title's save is queued or running, or the editor holds an unwritten edit. */
  readonly savePending: boolean;
  readonly savedContent: string;
  readonly dirty: boolean;
  readonly editorContent: string | undefined;
  readonly editorFocused: boolean;
  readonly composing: boolean;
  /** A title edit, which arms the title's rename. */
  debouncedSave: () => void;
  /** The editor's coalesced report that it applied an edit to the body. */
  editorEdited: () => void;
  resumeDraftPersistence: () => void;
  /** Saves now: a changed title renames the note, else the editor writes its draft;
   *  rejects when it fails. */
  flushSave: () => Promise<void>;
  /** The editor writes its draft now. Its reply also carries where the store moved the
   *  note, so the session has followed it when this settles. */
  checkpointEditor: () => Promise<void>;
  runWithSaveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  loadNote: (id: string | null) => Promise<void>;
  handleTitleInput: (event: Event) => void;
  /** Types `value` into the title field; false when no field is mounted. */
  setTitle: (value: string) => boolean;
  handleTitleKeydown: (event: KeyboardEvent) => void;
  handleTitleBlur: () => void;
  handleTitleFocus: (event: FocusEvent) => void;
  handleTitlePointerDown: (event: PointerEvent) => void;
  seedOpenNote: (id: string) => void;
  cancelAndClear: () => void;
  /** Adopts a peer's body (`freshContent`, as the verdict read it): the editor takes it
   *  from its host. */
  applyExternalContent: (freshContent: string) => void;
  /** Re-hands the open note to a newly created editor instance. */
  reattachEditor: () => void;
  /** Hears the notes a local workflow's backlink rewrite changed on disk. */
  noteRelinked: (ids: readonly string[]) => void;
  /** The editor now holds `toId`: a rename's final id, a parked copy (`keepsOriginal`),
   *  or where a store workflow moved it (a move, a sync relocation). */
  followEditorNote: (fromId: string, toId: string, keepsOriginal: boolean) => void;
  /** A save of the open note wrote it. */
  editorSaved: () => void;
}
