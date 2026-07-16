import { hasFileSystem } from '$lib/platform';
import { sanitizeFilename } from '$lib/rules';
import type { NotePreview } from '$shared/types/note';
import { notifySavedV2 } from '$features/sync/autoSyncV2';
import { createNoteSaveQueue } from './noteSaveQueue';
import { createNoteTitleController } from './createNoteTitleController.svelte';
import { createNotePersistence } from './createNotePersistence';
import { createNoteLoader } from './createNoteLoader';
import { editorHasUnseenChanges, isEditorChangeEcho } from './noteSessionChanges';
import { getNoteById } from './notes.svelte';

export {
  editorHasUnseenChanges,
  isEditorChangeEcho,
  shouldWriteNoteToDisk,
} from './noteSessionChanges';

export interface NoteSessionDeps {
  getEditorContent: () => string | undefined;
  setEditorContent: (text: string, opts?: { preserveSelection?: boolean }) => void;
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
  navigate: (path: string) => void;
}

export interface NoteSession {
  readonly title: string;
  readonly content: string;
  readonly originalId: string | null;
  readonly titleWarning: string;
  readonly loading: boolean;

  readonly editVersion: number;
  readonly lastEditTime: number;
  readonly savePending: boolean;
  readonly dirty: boolean;
  readonly editorContent: string | undefined;
  readonly editorFocused: boolean;
  readonly composing: boolean;
  debouncedSave: (content?: string) => void;
  flushSave: () => Promise<void>;
  runWithSaveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  loadNote: (id: string | null) => Promise<void>;
  handleTitleInput: (event: Event) => void;
  handleTitleKeydown: (event: KeyboardEvent) => void;
  handleTitleFocus: (event: FocusEvent) => void;
  handleTitlePointerDown: (event: PointerEvent) => void;
  seedOpenNote: (id: string, body: string) => void;
  cancelAndClear: () => void;
  applyExternalContent: (freshContent: string) => void;
  applyRemoteRename: (toId: string, newTitle: string) => void;
}

interface NoteSessionStatePatch {
  content?: string;
  loading?: boolean;
  originalId?: string | null;
  savedContent?: string;
  savedTitle?: string;
  title?: string;
}

function hasDuplicateNoteTitle(
  checkTitle: string,
  notes: NotePreview[],
  originalId: string | null,
  pendingFolder: string | null,
): boolean {
  const leaf = sanitizeFilename(checkTitle.trim() || 'Untitled');
  const slash = originalId?.lastIndexOf('/') ?? -1;
  const parentFolder = originalId
    ? slash === -1
      ? ''
      : originalId.slice(0, slash)
    : (pendingFolder ?? '');
  const checkId = parentFolder ? `${parentFolder}/${leaf}` : leaf;
  return notes.some((note) => note.id === checkId && note.id !== originalId);
}

const BODY_SAVE_DEBOUNCE_MS = 500;
const TITLE_SAVE_DEBOUNCE_MS = 10_000;

// eslint-disable-next-line max-lines-per-function -- One Svelte rune factory owns the draft baseline and serialized save lifecycle.
export function createNoteSession(deps: NoteSessionDeps): NoteSession {
  let title = $state('');
  let content = $state('');
  let originalId: string | null = $state(null);
  let savedTitle = $state('');
  let loading = $state(false);
  let savedContent = '';

  let suppressSaveOnChange = false;

  function patchState(patch: NoteSessionStatePatch): void {
    if (patch.title !== undefined) title = patch.title;
    if (patch.content !== undefined) content = patch.content;
    if (patch.savedContent !== undefined) savedContent = patch.savedContent;
    if (patch.savedTitle !== undefined) savedTitle = patch.savedTitle;
    if (patch.originalId !== undefined) originalId = patch.originalId;
    if (patch.loading !== undefined) loading = patch.loading;
  }

  function resetSessionState(): void {
    title = '';
    content = '';
    originalId = null;
    savedTitle = '';
    savedContent = '';
    loading = false;
  }

  const hasDuplicateTitle = (value: string) =>
    hasDuplicateNoteTitle(value, deps.getNotes(), originalId, deps.getPendingFolder?.() ?? null);

  const titleController = createNoteTitleController({
    setTitle: (value) => {
      title = value;
    },
    hasDuplicateTitle,
    scheduleSave: () => debouncedSave(),
    focusEditor: deps.focusEditor,
    getTextarea: deps.getTitleTextarea,
  });
  const saveNote = createNotePersistence({
    getEditorContent: deps.getEditorContent,
    getNoteId: deps.getNoteId,
    getPendingFolder: () => deps.getPendingFolder?.() ?? null,
    clearPendingFolder: () => deps.clearPendingFolder?.(),
    getState: () => ({ title, originalId, savedTitle, savedContent }),
    hasDuplicateTitle,
    showTitleWarning: (message) => titleController.showWarning(message, null),
    onSaved: ({ id, title: newTitle, content: newContent, savedOriginalId }) => {
      originalId = id;
      if (deps.getEditorContent() === newContent) content = newContent;
      savedContent = newContent;
      savedTitle = newTitle;
      if (savedOriginalId !== id) deps.onNoteRenamed(savedOriginalId, id);
    },
  });
  let persistenceTail: Promise<void> = Promise.resolve();

  function serializePersistence<T>(operation: () => Promise<T>): Promise<T> {
    const run = persistenceTail.then(operation, operation);
    persistenceTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const saveQueue = createNoteSaveQueue({
    save: () => serializePersistence(saveNote),
    hasUnseenChanges: hasUnseenEditorChanges,
    notifySaved: notifySavedV2,
  });
  const noteLoader = createNoteLoader({
    flushSave: saveQueue.flush,
    getNotes: deps.getNotes,
    getEditorContent: deps.getEditorContent,
    setEditorContent: (value) => deps.setEditorContent(value),
    getNoteBody: deps.getNoteBody,
    focusEditor: deps.focusEditor,
    autoResizeTitle: titleController.autoResizeTextarea,
    clearTitleWarning: titleController.clearWarning,
    navigate: deps.navigate,
    patchState,
    resetState: resetSessionState,
  });

  function debouncedSave(nextContent?: string): void {
    if (suppressSaveOnChange) return;
    if (isEditorChangeEcho({ nextContent, content, savedContent })) return;
    if (nextContent !== undefined) {
      content = nextContent;
    }
    if (loading || !hasFileSystem || deps.getNoteId() === null) return;
    const debounceMs = nextContent === undefined ? TITLE_SAVE_DEBOUNCE_MS : BODY_SAVE_DEBOUNCE_MS;
    saveQueue.schedule(debounceMs);
  }

  function hasUnseenEditorChanges(): boolean {
    if (loading || !hasFileSystem || deps.getNoteId() === null) return false;
    return editorHasUnseenChanges({
      editorContent: deps.getEditorContent(),
      savedContent,
      title,
      savedTitle,
    });
  }

  async function runWithSaveLock<T>(operation: () => Promise<T>): Promise<T> {
    await saveQueue.flush();
    return serializePersistence(operation);
  }

  function isDirty(): boolean {
    const noteId = deps.getNoteId();
    if (!originalId && noteId !== 'new') return false;
    return saveQueue.isPending() || hasUnseenEditorChanges();
  }

  function applyExternalContent(freshContent: string): void {
    content = freshContent;
    savedContent = freshContent;
    suppressSaveOnChange = true;
    try {
      deps.setEditorContent(freshContent, { preserveSelection: true });
    } finally {
      suppressSaveOnChange = false;
    }

    const meta = originalId ? getNoteById(originalId) : null;
    if (meta) {
      title = meta.title;
      savedTitle = meta.title;
    }
    titleController.clearWarning();
  }

  function applyRemoteRename(toId: string, newTitle: string): void {
    originalId = toId;
    title = newTitle;
    savedTitle = newTitle;
    titleController.clearWarning();
  }

  function seedOpenNote(id: string, body: string): void {
    originalId = id;
    title = id;
    savedTitle = id;
    content = body;
    savedContent = body;
    deps.setEditorContent(body);
    deps.setPrevNoteId(id);
    titleController.clearWarning();
    deps.navigate(`/note/${encodeURIComponent(id)}`);
  }

  function cancelAndClear(): void {
    noteLoader.cancel();
    saveQueue.cancelPending();
    titleController.clearWarning();
    resetSessionState();
    deps.navigate('/');
  }

  return {
    get title() {
      return title;
    },
    set title(v: string) {
      title = v;
    },
    get content() {
      return content;
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
      return saveQueue.editVersion;
    },
    get lastEditTime() {
      return saveQueue.lastEditTime;
    },
    get savePending() {
      return saveQueue.isPending();
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
    flushSave: saveQueue.flush,
    runWithSaveLock,
    loadNote: noteLoader.load,
    handleTitleInput: titleController.handleInput,
    handleTitleKeydown: titleController.handleKeydown,
    handleTitleFocus: titleController.handleFocus,
    handleTitlePointerDown: titleController.handlePointerDown,
    seedOpenNote,
    cancelAndClear,
    applyExternalContent,
    applyRemoteRename,
  };
}
