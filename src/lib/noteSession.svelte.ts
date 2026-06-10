/**
 * Note session controller — owns the note load/save/navigation state machine.
 *
 * Created once by NotesShell and drives title, content, save queue, and
 * title‑validation state. MarkdownEditor bindings and scrollParent stay in
 * NotesShell.
 */
import { hasFileSystem, isMobile, showSoftKeyboard } from '$lib/platform';
import {
  updateNote,
  readNote,
  createNote,
  getNoteById,
} from '$lib/notes.svelte';
import { sanitizeFilename } from '$lib/utils';
import { FORBIDDEN_CHARS_RE, validateTitle } from '$lib/rules';
import { navigate } from '../router';
import type { NotePreview } from '../types';

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
  /** Focuses the title textarea (mobile new-note flow). */
  focusTitle: () => void;
  /** Returns the current notes list. */
  getNotes: () => NotePreview[];
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
  /** When set, a brand-new note's first save is placed inside this
   *  folder (e.g. set by `New Note` in a folder context menu). Null/empty
   *  means "save to root". Cleared by the consumer after the first save. */
  getPendingFolder?: () => string | null;
  /** Called once the new-note's first save has consumed the pending
   *  folder so subsequent edits don't re-prefix it. */
  clearPendingFolder?: () => void;
  /** Called whenever a save results in an id rename: either a brand-new
   *  note getting its first real id (savedOriginalId === null) or an
   *  existing note's title being edited (savedOriginalId !== realId).
   *  The shell uses this to update which tab(s) point at the renamed note
   *  and to suppress the noteId-change effect's reload. */
  onNoteRenamed: (savedOriginalId: string | null, realId: string) => void;
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
  debouncedSave: (content?: string) => void;
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

/** Pure core of the flush-time dirty check: does the live editor (or title
 *  field) hold changes the debounced-save pipeline has not yet observed?
 *  This happens when the editor's rAF-coalesced onchange stalls — rAF does
 *  not fire while the window is hidden/occluded (macOS WKWebView), so the
 *  save timer is never armed for the latest keystrokes. `flushSave` uses
 *  this so a close/quit/note-switch flush still persists them. */
export function editorHasUnseenChanges(params: {
  editorContent: string | undefined;
  savedContent: string;
  title: string;
  savedTitle: string;
}): boolean {
  if (params.editorContent === undefined) return false;
  return params.editorContent !== params.savedContent || params.title !== params.savedTitle;
}

/** Pure core of the adopt-echo check: is this onchange delivery just the
 *  editor echoing content the session already applied and saved?
 *
 *  `applyExternalContent`/`loadNote` raise `suppressSaveOnChange` around
 *  their programmatic `setEditorContent`, but the editor's onchange is
 *  rAF-coalesced — the delivery lands a frame later, after the flag is
 *  already lowered. Counting that echo as an edit bumped `editVersion`,
 *  which made `handleSyncComplete`'s edited-during-sync gate silently skip
 *  every subsequent remote adopt of the open note: the first live-pulled
 *  edit appeared, later ones didn't until the note was reopened. An echo
 *  must match BOTH the session content and the saved content — a delivery
 *  that differs from either is a real edit (or a revert the session state
 *  still needs to converge on) and flows through. */
export function isEditorChangeEcho(params: {
  nextContent: string | undefined;
  content: string;
  savedContent: string;
}): boolean {
  if (params.nextContent === undefined) return false;
  return params.nextContent === params.content && params.nextContent === params.savedContent;
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
  let savedContent = '';

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
    const leaf = sanitizeFilename(checkTitle.trim() || 'Untitled');
    // Determine the target folder: keep the existing note's parent
    // when editing, fall back to the pending-folder when creating.
    const parentFolder = (() => {
      if (originalId) {
        const slash = originalId.lastIndexOf('/');
        return slash === -1 ? '' : originalId.slice(0, slash);
      }
      return deps.getPendingFolder?.() ?? '';
    })();
    const checkId = parentFolder ? `${parentFolder}/${leaf}` : leaf;
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

  function debouncedSave(nextContent?: string): void {
    if (suppressSaveOnChange) return;
    // Drop the rAF-deferred echo of programmatic setEditorContent — see
    // isEditorChangeEcho. Without this, every external adopt counted as a
    // user edit and blocked the NEXT remote adopt of the open note.
    if (isEditorChangeEcho({ nextContent, content, savedContent })) return;
    if (nextContent !== undefined) {
      content = nextContent;
    }
    if (loading || !hasFileSystem || deps.getNoteId() === null) return;
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
      } else if (!loading && hasUnseenEditorChanges()) {
        // The editor delivers changes through an rAF-coalesced onchange
        // (MarkdownEditor), and rAF stalls while the window is hidden or
        // occluded (notably macOS WKWebView). When that happens the save
        // timer was never armed, so a flush that only honors the timer
        // silently drops the user's latest keystrokes on close / quit /
        // note-switch. If the editor holds content the session hasn't seen,
        // treat it as a pending edit and save it now.
        await runQueuedSave();
      }
    } catch (e) {
      console.warn('Failed to flush note save:', e);
    }
  }

  /** True when the live editor (or title field) holds changes that the
   *  debounced-save pipeline has not yet observed — the rAF-starved
   *  onchange case. Mirrors the dirty check in `hasOpenDraftChanges`. */
  function hasUnseenEditorChanges(): boolean {
    if (!hasFileSystem || deps.getNoteId() === null) return false;
    return editorHasUnseenChanges({
      editorContent: deps.getEditorContent(),
      savedContent,
      title,
      savedTitle,
    });
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
      let newId = sanitizeFilename(newTitle);
      // The displayed title is the leaf component of the path-ID;
      // editing it must not relocate the note out of its parent folder.
      // For an existing note, prefix newId with the original folder
      // path. For a brand-new note opened via "New Note in <folder>",
      // prefix with the pending folder instead. The pending folder is
      // cleared after the first save so subsequent edits don't
      // re-prefix.
      if (originalId) {
        const slash = originalId.lastIndexOf('/');
        if (slash !== -1) {
          newId = `${originalId.slice(0, slash + 1)}${newId}`;
        }
      } else {
        const pendingFolder = deps.getPendingFolder?.();
        if (pendingFolder) {
          newId = `${pendingFolder}/${newId}`;
        }
      }
      const newContent = editorContent;

      if (!shouldWriteNoteToDisk({
        savedTitle,
        newTitle,
        content: savedContent,
        newContent,
      })) {
        return false;
      }

      // Block saving if another note already has this name
      if (hasDuplicateTitle(newTitle)) return false;

      const savedOriginalId = originalId;
      // updateNote routes through fileSystem.writeNote / deleteNoteFile /
      // renameNote which each record their own path — no explicit
      // suppression needed here.
      const result = await updateNote(newId, newTitle, newContent, savedOriginalId ?? undefined);

      originalId = result.id;
      // Clear pending-folder so subsequent saves of this same note
      // don't re-prefix and create infinite folder nesting.
      deps.clearPendingFolder?.();
      if (deps.getEditorContent() === newContent) {
        content = newContent;
      }
      savedContent = newContent;
      savedTitle = newTitle;

      // Patch graph data in-place so the graph view survives renames
      if (savedOriginalId && savedOriginalId !== result.id) {
        deps.patchGraphNode(savedOriginalId, result.id, newTitle);
      }

      if (savedOriginalId !== result.id) {
        deps.onNoteRenamed(savedOriginalId, result.id);
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
    clearTitleWarning();

    // Reset scroll position
    const noteBody = deps.getNoteBody();
    if (noteBody) noteBody.scrollTop = 0;

    if (!id) {
      title = '';
      content = '';
      savedContent = '';
      savedTitle = '';
      originalId = null;
      loading = false;
      return;
    }

    originalId = id !== 'new' ? id : null;

    if (id === 'new') {
      title = getNextUntitledTitle();
      content = '';
      savedContent = '';
      savedTitle = title;
      deps.setEditorContent('');
      loading = false;
      requestAnimationFrame(() => {
        if (loadVersion !== noteLoadVersion) return;
        autoResizeTitleTextarea();
        if (isMobile) {
          // Mobile '+ New' / quick capture: land focus on the title so the
          // select-all-on-focus behavior (handleTitleFocus) lets typing
          // replace "Untitled" immediately. Desktop keeps body focus.
          deps.focusTitle();
        } else {
          deps.focusEditor();
        }
        // Android: programmatic focus doesn't always raise the IME. Bridge
        // to InputMethodManager so a fresh note brings the keyboard up
        // immediately. (On iOS this also retires the keyboard primer from
        // primeSoftKeyboardForProgrammaticFocus — the focused field
        // inherits its active keyboard session.)
        void showSoftKeyboard();
      });
    } else if (hasFileSystem) {
      try {
        const loadedContent = await readNote(id);
        if (loadVersion !== noteLoadVersion) return;
        content = loadedContent;
        savedContent = loadedContent;
        const meta = getNoteById(id);
        // Title is the leaf component of the path-ID (the visible
        // filename without any parent folder). When meta is missing
        // we fall back to the same leaf-of-id rule rather than
        // surfacing the full path in the title field.
        const slash = id.lastIndexOf('/');
        const fallbackTitle = slash === -1 ? id : id.slice(slash + 1);
        title = meta?.title || fallbackTitle;
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
          const slash = result.id.lastIndexOf('/');
          const newTitle = slash === -1 ? result.id : result.id.slice(slash + 1);
          title = newTitle;
          content = '';
          savedContent = '';
          savedTitle = newTitle;
          originalId = result.id;
          deps.setEditorContent('');
          loading = false;
          requestAnimationFrame(() => {
            if (loadVersion !== noteLoadVersion) return;
            autoResizeTitleTextarea();
            deps.focusEditor();
            void showSoftKeyboard();
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
    savedContent = freshContent;
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
    clearTitleWarning();
  }

  function applyRemoteRename(toId: string, newTitle: string): void {
    originalId = toId;
    title = newTitle;
    savedTitle = newTitle;
    clearTitleWarning();
  }

  function seedOpenNote(id: string, body: string): void {
    originalId = id;
    title = id;
    savedTitle = id;
    content = body;
    savedContent = body;
    deps.setEditorContent(body);
    deps.setPrevNoteId(id);
    clearTitleWarning();
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  function cancelAndClear(): void {
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    clearTitleWarning();
    originalId = null;
    content = '';
    savedContent = '';
    savedTitle = '';
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
      return currentContent !== savedContent || title !== savedTitle;
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
