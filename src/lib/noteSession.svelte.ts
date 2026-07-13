import { hasFileSystem } from '$lib/platform';
import { notifySavedV2 } from '$lib/autoSyncV2';
import { getNoteById, readNote, updateNote } from '$lib/notes.svelte';
import { FORBIDDEN_CHARS_RE, validateTitle } from '$lib/rules';
import { sanitizeFilename } from '$lib/utils';
import { navigate } from '../router';
import type { NotePreview } from '../types';

const BODY_SAVE_DELAY_MS = 500;
const TITLE_SAVE_DELAY_MS = 10_000;

export interface NoteSessionDeps {
  getEditorContent: () => string | undefined;
  setEditorContent: (text: string, options?: { preserveSelection?: boolean }) => void;
  focusEditor: () => void;
  isEditorFocused: () => boolean;
  isComposing: () => boolean;
  getNotes: () => NotePreview[];
  getNoteBody: () => HTMLElement | undefined;
  getTitleTextarea: () => HTMLTextAreaElement | undefined;
  getNoteId: () => string | null;
  getPendingFolder: () => string | null;
  clearPendingFolder: () => void;
  onNoteRenamed: (fromId: string | null, toId: string, title: string) => void;
}

export interface NoteSession {
  title: string;
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
  loadNote: (id: string | null) => Promise<void>;
  handleTitleInput: (event: Event) => void;
  handleTitleKeydown: (event: KeyboardEvent) => void;
  handleTitleFocus: (event: FocusEvent) => void;
  handleTitlePointerDown: (event: PointerEvent) => void;
  seedOpenNote: (id: string, body: string) => void;
  cancelAndClear: () => void;
  applyExternalContent: (content: string) => void;
  applyRemoteRename: (toId: string, title: string) => void;
}

export function shouldWriteNoteToDisk(params: {
  savedTitle: string;
  newTitle: string;
  content: string;
  newContent: string;
}): boolean {
  return params.savedTitle !== params.newTitle || params.content !== params.newContent;
}

export function editorHasUnseenChanges(params: {
  editorContent: string | undefined;
  savedContent: string;
  title: string;
  savedTitle: string;
}): boolean {
  return (
    params.editorContent !== undefined &&
    (params.editorContent !== params.savedContent || params.title !== params.savedTitle)
  );
}

export function isEditorChangeEcho(params: {
  nextContent: string | undefined;
  content: string;
  savedContent: string;
}): boolean {
  return (
    params.nextContent !== undefined &&
    params.nextContent === params.content &&
    params.nextContent === params.savedContent
  );
}

// eslint-disable-next-line max-lines-per-function -- One Svelte rune factory is the sole owner of the draft baseline and serialized save lifecycle.
export function createNoteSession(deps: NoteSessionDeps): NoteSession {
  let title = $state('');
  let content = $state('');
  let originalId = $state<string | null>(null);
  let titleWarning = $state('');
  let loading = $state(false);

  let savedTitle = '';
  let savedContent = '';
  let editVersion = 0;
  let lastEditTime = 0;
  let loadVersion = 0;
  let saveTimer: number | null = null;
  let saveRequested = false;
  let saveLoop: Promise<void> | null = null;
  let warningTimer: number | null = null;
  let applyingContent = false;

  function liveEditorIsDirty(): boolean {
    if (!hasFileSystem || deps.getNoteId() === null) return false;
    return editorHasUnseenChanges({
      editorContent: deps.getEditorContent(),
      savedContent,
      title,
      savedTitle,
    });
  }

  function parentFolder(): string {
    if (!originalId) return deps.getPendingFolder() ?? '';
    const slash = originalId.lastIndexOf('/');
    return slash === -1 ? '' : originalId.slice(0, slash);
  }

  function nextUntitledTitle(): string {
    const ids = new Set(deps.getNotes().map((note) => note.id));
    if (!ids.has('Untitled')) return 'Untitled';
    let suffix = 1;
    while (ids.has(`Untitled (${suffix})`)) suffix += 1;
    return `Untitled (${suffix})`;
  }

  function duplicateTitle(candidate: string): boolean {
    const leaf = sanitizeFilename(candidate.trim() || 'Untitled');
    const folder = parentFolder();
    const id = folder ? `${folder}/${leaf}` : leaf;
    return deps.getNotes().some((note) => note.id === id && note.id !== originalId);
  }

  function clearWarning(): void {
    if (warningTimer !== null) clearTimeout(warningTimer);
    warningTimer = null;
    titleWarning = '';
  }

  function warn(message: string, durationMs?: number): void {
    clearWarning();
    titleWarning = message;
    if (durationMs === undefined) return;
    warningTimer = window.setTimeout(clearWarning, durationMs);
  }

  function resizeTitle(): void {
    const element = deps.getTitleTextarea();
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }

  function cancelSaveTimer(): boolean {
    if (saveTimer === null) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    return true;
  }

  function scheduleSave(delayMs: number): void {
    cancelSaveTimer();
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      requestSave();
    }, delayMs);
  }

  function requestSave(): void {
    saveRequested = true;
    if (saveLoop) return;
    const running = drainSaves();
    saveLoop = running;
    void running.finally(() => {
      if (saveLoop === running) saveLoop = null;
      if (saveRequested) requestSave();
    });
  }

  async function drainSaves(): Promise<void> {
    while (saveRequested) {
      saveRequested = false;
      if (await saveOnce()) notifySavedV2();
    }
  }

  async function saveOnce(): Promise<boolean> {
    const routeId = deps.getNoteId();
    const editorContent = deps.getEditorContent();
    if (!hasFileSystem || routeId === null || editorContent === undefined || loading) return false;

    const newTitle = title.trim() || 'Untitled';
    const blockingIssue = validateTitle(newTitle).find((issue) => issue.kind !== 'empty');
    if (blockingIssue) {
      warn(blockingIssue.message);
      return false;
    }
    if (duplicateTitle(newTitle)) return false;
    if (
      !shouldWriteNoteToDisk({
        savedTitle,
        newTitle,
        content: savedContent,
        newContent: editorContent,
      })
    ) {
      return false;
    }

    const fromId = originalId;
    const folder = parentFolder();
    const leaf = sanitizeFilename(newTitle);
    const requestedId = folder ? `${folder}/${leaf}` : leaf;

    try {
      const result = await updateNote(requestedId, newTitle, editorContent, fromId ?? undefined);
      originalId = result.id;
      deps.clearPendingFolder();
      savedTitle = newTitle;
      savedContent = editorContent;
      if (deps.getEditorContent() === editorContent) content = editorContent;
      if (fromId !== result.id) deps.onNoteRenamed(fromId, result.id, newTitle);
      return true;
    } catch (error) {
      console.warn('Failed to save note:', error);
      return false;
    }
  }

  function debouncedSave(nextContent?: string): void {
    if (applyingContent) return;
    if (isEditorChangeEcho({ nextContent, content, savedContent })) return;
    if (nextContent !== undefined) content = nextContent;
    if (loading || !hasFileSystem || deps.getNoteId() === null) return;
    lastEditTime = Date.now();
    editVersion += 1;
    scheduleSave(nextContent === undefined ? TITLE_SAVE_DELAY_MS : BODY_SAVE_DELAY_MS);
  }

  async function flushSave(): Promise<void> {
    const hadTimer = cancelSaveTimer();
    if (hadTimer || liveEditorIsDirty()) requestSave();
    while (saveLoop) {
      const current = saveLoop;
      try {
        await current;
      } catch (error) {
        console.warn('Failed to flush note save:', error);
      }
      if (saveLoop === current) break;
    }
  }

  function reset(): void {
    title = '';
    content = '';
    originalId = null;
    savedTitle = '';
    savedContent = '';
    clearWarning();
  }

  async function loadNote(id: string | null): Promise<void> {
    const version = ++loadVersion;
    await flushSave();
    if (version !== loadVersion) return;

    loading = true;
    clearWarning();
    const body = deps.getNoteBody();
    if (body) body.scrollTop = 0;

    if (id === null) {
      reset();
      loading = false;
      return;
    }

    originalId = id === 'new' ? null : id;
    if (id === 'new') {
      title = nextUntitledTitle();
      savedTitle = title;
      content = '';
      savedContent = '';
      deps.setEditorContent('');
      loading = false;
      requestAnimationFrame(() => {
        if (version !== loadVersion) return;
        resizeTitle();
        deps.focusEditor();
      });
      return;
    }

    try {
      const diskContent = await readNote(id);
      if (version !== loadVersion) return;
      content = diskContent;
      savedContent = diskContent;
      const slash = id.lastIndexOf('/');
      title = getNoteById(id)?.title ?? (slash === -1 ? id : id.slice(slash + 1));
      savedTitle = title;
      deps.setEditorContent(diskContent);

      // CM6 normalizes line endings. Opening a note must not turn that
      // representation change into a write, mtime bump, or sync conflict.
      const normalized = deps.getEditorContent();
      if (normalized !== undefined) {
        content = normalized;
        savedContent = normalized;
      }
      requestAnimationFrame(() => {
        if (version === loadVersion) resizeTitle();
      });
    } catch {
      if (version !== loadVersion) return;
      reset();
      navigate('/');
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  function handleTitleInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    const noNewlines = input.value.replace(/[\r\n]/g, '');
    const cleaned = noNewlines.replace(FORBIDDEN_CHARS_RE, '');
    const cursor = input.selectionStart ?? cleaned.length;

    title = cleaned;
    if (cleaned !== noNewlines) {
      requestAnimationFrame(() =>
        input.setSelectionRange(Math.max(0, cursor - 1), Math.max(0, cursor - 1)),
      );
      warn("That character can't be used in a note title", 2000);
    } else if (cleaned !== input.value) {
      requestAnimationFrame(() => input.setSelectionRange(cursor, cursor));
    } else {
      const issue = validateTitle(cleaned).find((candidate) =>
        ['leading_dots', 'trailing_dots', 'too_long'].includes(candidate.kind),
      );
      if (issue) warn(issue.message);
      else if (duplicateTitle(cleaned)) warn('A note with this name already exists');
      else clearWarning();
    }
    resizeTitle();
    debouncedSave();
  }

  function selectPlaceholderTitle(input: HTMLTextAreaElement): void {
    if (!input.value.startsWith('Untitled')) return;
    input.setSelectionRange(0, input.value.length);
    requestAnimationFrame(() => input.setSelectionRange(0, input.value.length));
  }

  function applyExternalContent(freshContent: string): void {
    content = freshContent;
    savedContent = freshContent;
    applyingContent = true;
    deps.setEditorContent(freshContent, { preserveSelection: true });
    applyingContent = false;
    const meta = originalId ? getNoteById(originalId) : undefined;
    if (meta) {
      title = meta.title;
      savedTitle = meta.title;
    }
    clearWarning();
  }

  function applyRemoteRename(toId: string, newTitle: string): void {
    originalId = toId;
    title = newTitle;
    savedTitle = newTitle;
    clearWarning();
  }

  function seedOpenNote(id: string, body: string): void {
    originalId = id;
    title = id;
    savedTitle = id;
    content = body;
    savedContent = body;
    deps.setEditorContent(body);
    clearWarning();
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  function cancelAndClear(): void {
    loadVersion += 1;
    cancelSaveTimer();
    saveRequested = false;
    reset();
    navigate('/');
  }

  return {
    get title() {
      return title;
    },
    set title(value: string) {
      title = value;
    },
    get content() {
      return content;
    },
    get originalId() {
      return originalId;
    },
    get titleWarning() {
      return titleWarning;
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
    get savePending() {
      return saveTimer !== null || saveRequested || saveLoop !== null;
    },
    get dirty() {
      if (!originalId && deps.getNoteId() !== 'new') return false;
      return this.savePending || liveEditorIsDirty();
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
    flushSave,
    loadNote,
    handleTitleInput,
    handleTitleKeydown(event: KeyboardEvent) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      deps.focusEditor();
    },
    handleTitleFocus(event: FocusEvent) {
      selectPlaceholderTitle(event.currentTarget as HTMLTextAreaElement);
    },
    handleTitlePointerDown(event: PointerEvent) {
      const input = event.currentTarget as HTMLTextAreaElement;
      if (!input.value.startsWith('Untitled')) return;
      event.preventDefault();
      input.focus();
      selectPlaceholderTitle(input);
    },
    seedOpenNote,
    cancelAndClear,
    applyExternalContent,
    applyRemoteRename,
  };
}
