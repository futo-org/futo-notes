/**
 * Note session controller — owns the note load/save/navigation state machine.
 *
 * Created once by NotesShell and drives title, content, save queue, and
 * title‑validation state. MarkdownEditor bindings and scrollParent stay in
 * NotesShell.
 */
import { hasFileSystem } from '$lib/platform';
import {
  updateNote,
  readNote,
  createNote,
  getNoteById,
} from '$lib/notes.svelte';
import { sanitizeFilename } from '$lib/utils';
import { FORBIDDEN_CHARS_RE, validateTitle } from '@futo-notes/shared';
import { navigate } from '../router';
import type { NotePreview } from '../types';
import type { WriteSuppressor } from '$lib/writeSuppression';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteSessionDeps {
  /** Returns the current editor content (CM6 doc string). */
  getEditorContent: () => string | undefined;
  /** Replaces editor content (optional preserveSelection). */
  setEditorContent: (text: string, opts?: { preserveSelection?: boolean }) => void;
  /** Focuses the editor. */
  focusEditor: () => void;
  /** Returns the current notes list. */
  getNotes: () => NotePreview[];
  /** Write‑suppression instance (shared with watcher/sync). */
  writeSuppressor: WriteSuppressor;
  /** Patches graph node after rename. */
  patchGraphNode: (fromId: string, toId: string, newTitle: string) => void;
  /** Shows a toast message. */
  showToast: (message: string) => void;
  /** Notifies auto‑sync that a save happened. */
  notifySaved: () => void;
  /** Returns the scroll container element for scroll‑top reset. */
  getNoteBody: () => HTMLElement | undefined;
  /** Returns the title textarea for auto‑resize. */
  getTitleTextarea: () => HTMLTextAreaElement | undefined;
  /** Current noteId prop from the router. Read lazily. */
  getNoteId: () => string | null;
  /** Update prevNoteId to prevent duplicate loadNote on URL change. */
  setPrevNoteId: (id: string) => void;
}

export interface NoteSession {
  // --- Reactive getters (Svelte 5 runes) ---
  readonly title: string;
  readonly content: string;
  readonly originalId: string | null;
  readonly savedTitle: string;
  readonly titleWarning: string;
  readonly loading: boolean;

  // --- Imperative API ---
  readonly editVersion: number;
  readonly lastEditTime: number;
  isSavePending: () => boolean;
  hasOpenDraftChanges: () => boolean;
  debouncedSave: () => void;
  flushSave: () => Promise<void>;
  loadNote: (id: string | null) => Promise<void>;
  handleTitleInput: (event: Event) => void;
  handleTitleKeydown: (event: KeyboardEvent) => void;
  handleTitleFocus: (event: FocusEvent) => void;
  handleTitlePointerDown: (event: PointerEvent) => void;
  autoResizeTitleTextarea: () => void;
  /**
   * Seed the session with a known note for dev/test use.
   * Sets all reactive state and syncs the editor.
   */
  seedOpenNote: (id: string, body: string) => void;
  /** Cancel any pending save and clear the session (e.g. on delete/import nuke). */
  cancelAndClear: () => void;
  /** Update prevNoteId to prevent duplicate loadNote on URL change. */
  setPrevNoteId: (id: string) => void;
  /** Called by watcher/sync when the open note was changed externally. */
  applyExternalContent: (freshContent: string) => void;
  /** Called by sync when the open note was renamed remotely. */
  applyRemoteRename: (toId: string, newTitle: string) => void;
}

export function shouldWriteNoteToDisk(params: {
  savedTitle: string;
  newTitle: string;
  content: string;
  newContent: string;
}): boolean {
  return !(params.newTitle === params.savedTitle && params.newContent === params.content);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-lines-per-function -- Svelte 5 rune factory keeps reactive state, save queue, and note lifecycle colocated.
export function createNoteSession(deps: NoteSessionDeps): NoteSession {
  // --- Reactive state (Svelte 5 runes) ---
  let title = $state('');
  let content = $state('');
  let originalId: string | null = $state(null);
  let savedTitle = $state('');
  let titleWarning = $state('');
  let loading = $state(false);

  // --- Non-reactive save‑queue state ---
  let saveTimeout: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;
  let lastEditTime = 0;
  let editVersion = 0;
  let noteLoadVersion = 0;
  let titleWarningTimer: number | null = null;
  let suppressSaveOnChange = false;

  // --- Helpers ---

  function getNextUntitledTitle(): string {
    const base = 'Untitled';
    const notes = deps.getNotes();
    const existingIds = new Set(notes.map(n => n.id));
    if (!existingIds.has(sanitizeFilename(base))) return base;
    let i = 1;
    while (existingIds.has(sanitizeFilename(`${base} (${i})`))) i++;
    return `${base} (${i})`;
  }

  function hasDuplicateTitle(checkTitle: string): boolean {
    const checkId = sanitizeFilename(checkTitle.trim() || 'Untitled');
    const notes = deps.getNotes();
    return notes.some(n => n.id === checkId && n.id !== originalId);
  }

  function showTitleWarning(message: string, autoHideMs: number | null): void {
    if (titleWarningTimer !== null) clearTimeout(titleWarningTimer);
    titleWarning = message;
    titleWarningTimer = autoHideMs !== null
      ? window.setTimeout(() => { titleWarning = ''; titleWarningTimer = null; }, autoHideMs)
      : null;
  }

  function clearTitleWarning(): void {
    if (titleWarningTimer !== null) clearTimeout(titleWarningTimer);
    titleWarning = '';
    titleWarningTimer = null;
  }

  function autoResizeTitleTextarea(): void {
    const el = deps.getTitleTextarea();
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  // --- Save machinery ---

  function debouncedSave(): void {
    if (suppressSaveOnChange || loading || !hasFileSystem || deps.getNoteId() === null) return;
    lastEditTime = Date.now();
    editVersion++;
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = window.setTimeout(() => {
      saveTimeout = null;
      void runQueuedSave();
    }, 500);
  }

  async function flushSave(): Promise<void> {
    const hadPendingTimer = saveTimeout !== null;
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    try {
      if (hadPendingTimer) {
        await runQueuedSave();
      } else if (saveInFlight !== null) {
        await saveInFlight;
      }
    } catch (e) {
      console.warn('Failed to flush note save:', e);
    }
  }

  async function runQueuedSave(): Promise<void> {
    if (saveInFlight !== null) {
      saveQueued = true;
      await saveInFlight;
      return;
    }

    const run = (async () => {
      do {
        saveQueued = false;
        const wrote = await saveNote();
        if (wrote) deps.notifySaved();
      } while (saveQueued);
    })();

    saveInFlight = run;
    try {
      await run;
    } finally {
      if (saveInFlight === run) {
        saveInFlight = null;
      }
    }
  }

  async function saveNote(): Promise<boolean> {
    const noteId = deps.getNoteId();
    const editorContent = deps.getEditorContent();
    if (!hasFileSystem || editorContent === undefined || noteId === null) return false;
    try {
      const newTitle = title.trim() || 'Untitled';
      const titleIssues = validateTitle(newTitle);
      const blockingTitleIssue = titleIssues.find((issue) => issue.kind !== 'empty');
      if (blockingTitleIssue) {
        showTitleWarning(blockingTitleIssue.message, null);
        return false;
      }
      const newId = sanitizeFilename(newTitle);
      const newContent = editorContent;

      if (!shouldWriteNoteToDisk({
        savedTitle,
        newTitle,
        content,
        newContent,
      })) {
        return false;
      }

      // Block saving if another note already has this name
      if (hasDuplicateTitle(newTitle)) return false;

      const savedOriginalId = originalId;
      if (savedOriginalId) {
        deps.writeSuppressor.recordWrite(`${savedOriginalId}.md`);
        if (savedOriginalId !== newId) {
          deps.writeSuppressor.recordWrite(`${newId}.md`);
        }
      }

      const result = await updateNote(newId, newTitle, newContent, savedOriginalId ?? undefined);

      deps.writeSuppressor.recordWrite(`${result.id}.md`);
      if (savedOriginalId && savedOriginalId !== result.id) {
        deps.writeSuppressor.recordWrite(`${savedOriginalId}.md`);
      }

      originalId = result.id;
      if (deps.getEditorContent() === newContent) {
        content = newContent;
      }
      savedTitle = newTitle;

      // Patch graph data in-place so the graph view survives renames
      if (savedOriginalId && savedOriginalId !== result.id) {
        deps.patchGraphNode(savedOriginalId, result.id, newTitle);
      }

      // Only update URL if user is still viewing this note
      const currentPath = window.location.hash.slice(1) || '/';
      const stillOnThisNote = savedOriginalId
        ? currentPath === `/note/${encodeURIComponent(savedOriginalId)}`
        : currentPath === '/note/new';

      if (stillOnThisNote && currentPath !== `/note/${encodeURIComponent(result.id)}`) {
        deps.setPrevNoteId(result.id);
        navigate(`/note/${encodeURIComponent(result.id)}`);
      }
      return true;
    } catch (e) {
      console.warn('Failed to save note:', e);
      return false;
    }
  }

  // --- Load ---

  async function loadNote(id: string | null): Promise<void> {
    const loadVersion = ++noteLoadVersion;
    await flushSave();
    if (loadVersion !== noteLoadVersion) return;

    loading = true;

    // Reset scroll position
    const noteBody = deps.getNoteBody();
    if (noteBody) noteBody.scrollTop = 0;

    if (!id) {
      title = '';
      content = '';
      savedTitle = '';
      originalId = null;
      loading = false;
      return;
    }

    originalId = id !== 'new' ? id : null;

    if (id === 'new') {
      title = getNextUntitledTitle();
      content = '';
      savedTitle = title;
      deps.setEditorContent('');
      loading = false;
      requestAnimationFrame(() => {
        if (loadVersion !== noteLoadVersion) return;
        autoResizeTitleTextarea();
        deps.focusEditor();
      });
    } else if (hasFileSystem) {
      try {
        const loadedContent = await readNote(id);
        if (loadVersion !== noteLoadVersion) return;
        content = loadedContent;
        const meta = getNoteById(id);
        title = meta?.title || id;
        savedTitle = title;
        deps.setEditorContent(loadedContent);
        requestAnimationFrame(() => {
          if (loadVersion !== noteLoadVersion) return;
          autoResizeTitleTextarea();
        });
      } catch {
        if (loadVersion !== noteLoadVersion) return;
        // Note doesn't exist — create it (e.g. wikilink to new note)
        try {
          const result = await createNote(id, '');
          if (loadVersion !== noteLoadVersion) return;
          title = id;
          content = '';
          savedTitle = id;
          originalId = result.id;
          deps.setEditorContent('');
          loading = false;
          requestAnimationFrame(() => {
            if (loadVersion !== noteLoadVersion) return;
            autoResizeTitleTextarea();
            deps.focusEditor();
          });
          return;
        } catch {
          loading = false;
          navigate('/');
          return;
        }
      }
      loading = false;
    }
  }

  // --- Title handlers ---

  function handleTitleInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    let cleaned = input.value.replace(/[\r\n]/g, '');
    const hadForbidden = cleaned !== cleaned.replace(FORBIDDEN_CHARS_RE, '');
    cleaned = cleaned.replace(FORBIDDEN_CHARS_RE, '');
    if (hadForbidden) {
      const pos = input.selectionStart ?? cleaned.length;
      title = cleaned;
      requestAnimationFrame(() => {
        input.setSelectionRange(pos - 1, pos - 1);
      });
      showTitleWarning("That character can't be used in a note title", 2000);
    } else if (input.value !== cleaned) {
      const pos = input.selectionStart ?? cleaned.length;
      title = cleaned;
      requestAnimationFrame(() => {
        input.setSelectionRange(pos, pos);
      });
    } else {
      const issues = validateTitle(cleaned);
      const dotOrLength = issues.find(
        (i) => i.kind === 'leading_dots' || i.kind === 'trailing_dots' || i.kind === 'too_long',
      );
      if (dotOrLength) {
        showTitleWarning(dotOrLength.message, null);
      } else if (hasDuplicateTitle(cleaned)) {
        showTitleWarning('A note with this name already exists', null);
      } else {
        clearTitleWarning();
      }
    }
    autoResizeTitleTextarea();
    debouncedSave();
  }

  function handleTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      deps.focusEditor();
    }
  }

  function shouldAutoSelectUntitledTitle(value: string): boolean {
    return value.startsWith('Untitled');
  }

  function selectAllTitleText(input: HTMLTextAreaElement): void {
    input.setSelectionRange(0, input.value.length);
    requestAnimationFrame(() => {
      input.setSelectionRange(0, input.value.length);
    });
  }

  function handleTitleFocus(event: FocusEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (shouldAutoSelectUntitledTitle(input.value)) {
      selectAllTitleText(input);
    }
  }

  function handleTitlePointerDown(event: PointerEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (shouldAutoSelectUntitledTitle(input.value)) {
      event.preventDefault();
      input.focus();
      selectAllTitleText(input);
    }
  }

  // --- External mutation helpers ---

  function applyExternalContent(freshContent: string): void {
    content = freshContent;
    suppressSaveOnChange = true;
    deps.setEditorContent(freshContent, { preserveSelection: true });
    suppressSaveOnChange = false;
    if (originalId) {
      const meta = getNoteById(originalId);
      if (meta) {
        title = meta.title;
        savedTitle = meta.title;
      }
    }
  }

  function applyRemoteRename(toId: string, newTitle: string): void {
    originalId = toId;
    title = newTitle;
    savedTitle = newTitle;
  }

  function seedOpenNote(id: string, body: string): void {
    originalId = id;
    title = id;
    savedTitle = id;
    content = body;
    deps.setEditorContent(body);
    deps.setPrevNoteId(id);
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  function cancelAndClear(): void {
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    originalId = null;
    navigate('/');
  }

  function setPrevNoteId(id: string): void {
    deps.setPrevNoteId(id);
  }

  // --- noteId change tracking ---
  // The caller ($effect in NotesShell) drives this. We just expose loadNote.

  return {
    get title() { return title; },
    set title(v: string) { title = v; },
    get content() { return content; },
    get originalId() { return originalId; },
    get savedTitle() { return savedTitle; },
    get titleWarning() { return titleWarning; },
    get loading() { return loading; },
    get editVersion() { return editVersion; },
    get lastEditTime() { return lastEditTime; },
    isSavePending: () => saveTimeout !== null || saveInFlight !== null || saveQueued,
    hasOpenDraftChanges(): boolean {
      const noteId = deps.getNoteId();
      if (!originalId && noteId !== 'new') return false;
      if (saveTimeout !== null || saveInFlight !== null || saveQueued) return true;
      const currentContent = deps.getEditorContent() ?? content;
      return currentContent !== content || title !== savedTitle;
    },
    debouncedSave,
    flushSave,
    loadNote,
    handleTitleInput,
    handleTitleKeydown,
    handleTitleFocus,
    handleTitlePointerDown,
    autoResizeTitleTextarea,
    seedOpenNote,
    cancelAndClear,
    applyExternalContent,
    applyRemoteRename,
    setPrevNoteId,
  };
}
