import type { NotePreview } from '$shared/types/note';

export interface NoteSessionDeps {
  getEditorContent: () => string | undefined;
  setEditorContent: (text: string) => void;
  /** Points the editor at a note; a `null` id is an unsaved new note. */
  openEditorNote: (noteId: string | null, text: string) => void;
  focusEditor: () => void;
  isEditorFocused: () => boolean;
  isComposing: () => boolean;
  getNotes: () => NotePreview[];
  getNoteBody: () => HTMLElement | undefined;
  getTitleTextarea: () => HTMLTextAreaElement | undefined;
  getNoteId: () => string | null;
  setPrevNoteId: (id: string) => void;
  getPendingFolder?: () => string | null;
  clearPendingFolder?: () => void;
  onNoteRenamed: (savedOriginalId: string | null, realId: string) => void;
  reconcileOpenNote: (id: string, parkedDraft: ParkedDraftSnapshot) => Promise<unknown>;
  navigate: (path: string) => void;
  /** The desktop vault refuses writes: nothing can be saved for the rest of the launch. */
  isVaultLocked?: () => boolean;
}

/** The exact body and title a save parked as a conflict copy. */
export interface ParkedDraftSnapshot {
  content: string;
  title: string;
}

export interface NoteSession {
  readonly title: string;
  /** What the title field shows: `title`, unless a commit landed while it was focused (list.md). */
  readonly fieldTitle: string;
  readonly content: string;
  readonly originalId: string | null;
  readonly titleWarning: string;
  readonly loading: boolean;

  readonly editVersion: number;
  readonly lastEditTime: number;
  readonly savePending: boolean;
  readonly savedContent: string;
  readonly dirty: boolean;
  readonly editorContent: string | undefined;
  readonly editorFocused: boolean;
  readonly composing: boolean;
  debouncedSave: (content?: string) => void;
  resumeDraftPersistence: () => void;
  flushSave: () => Promise<void>;
  runWithSaveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  loadNote: (id: string | null) => Promise<void>;
  handleTitleInput: (event: Event) => void;
  handleTitleKeydown: (event: KeyboardEvent) => void;
  handleTitleBlur: () => void;
  handleTitleFocus: (event: FocusEvent) => void;
  handleTitlePointerDown: (event: PointerEvent) => void;
  seedOpenNote: (id: string, body: string) => void;
  cancelAndClear: () => void;
  /** Adopts a peer's body; renames arrive through applyRemoteRename. */
  applyExternalContent: (freshContent: string) => void;
  /** Re-hands the open note to a newly created editor instance. */
  reattachEditor: () => void;
  /** Replaces the saved-content base without changing the live editor buffer. */
  rebaseSavedContent: (freshContent: string) => void;
  /** Hears the notes a local workflow's backlink rewrite changed on disk. */
  noteRelinked: (ids: readonly string[]) => void;
  applyRemoteRename: (toId: string, newTitle: string) => void;
}
