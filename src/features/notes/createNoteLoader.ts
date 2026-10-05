import { hasFileSystem } from '$lib/platform';
import { sanitizeFilename } from '$lib/rules';
import { markNoteSwitch } from '$shared/perf/noteSwitchTimeline';
import type { NotePreview } from '$shared/types/note';

import { getNoteById, readNote } from './notes.svelte';

interface NoteLoadPatch {
  content?: string;
  loading?: boolean;
  originalId?: string | null;
  savedContent?: string;
  savedTitle?: string;
  title?: string;
}

interface CreateNoteLoaderOptions {
  autoResizeTitle: () => void;
  clearTitleWarning: () => void;
  flushSave: () => Promise<void>;
  focusEditor: () => void;
  getEditorContent: () => string | undefined;
  getNoteBody: () => HTMLElement | undefined;
  getNotes: () => NotePreview[];
  /** A save of the open note is armed, running or queued. */
  isSavePending: () => boolean;
  navigate: (path: string) => void;
  patchState: (patch: NoteLoadPatch) => void;
  resetState: () => void;
  openNote: (noteId: string | null, content: string) => void;
}

function getNextUntitledTitle(notes: NotePreview[]): string {
  const base = 'Untitled';
  const existingIds = new Set(notes.map((note) => note.id));
  if (!existingIds.has(sanitizeFilename(base))) return base;
  let suffix = 1;
  while (existingIds.has(sanitizeFilename(`${base} (${suffix})`))) suffix += 1;
  return `${base} (${suffix})`;
}

export function createNoteLoader(options: CreateNoteLoaderOptions) {
  let loadVersion = 0;

  function finishNewNote(version: number, title: string): void {
    options.patchState({
      title,
      content: '',
      savedContent: '',
      savedTitle: title,
      loading: false,
    });
    options.openNote(null, '');
    requestAnimationFrame(() => {
      if (version !== loadVersion) return;
      options.autoResizeTitle();
      options.focusEditor();
    });
  }

  /**
   * Reads the incoming note while the outgoing one is still the session's.
   *
   * The outgoing note stays mounted, visible and focused for as long as the
   * read takes, so a keystroke typed now is ITS edit (RC-10: a keyboard tab
   * switch, then typing). The session keeps saving it as usual, and whenever
   * the read let an edit in, the outgoing note is flushed again and the
   * incoming one re-read, so the replace that follows discards nothing. The
   * last read's resolution and that replace then run in one task: no keystroke
   * can land between them.
   */
  async function readIncoming(
    id: string,
    version: number,
  ): Promise<{ content: string } | { error: unknown } | null> {
    for (;;) {
      const outgoing = options.getEditorContent();
      let result: { content: string } | { error: unknown };
      try {
        markNoteSwitch('readStarted');
        result = { content: await readNote(id) };
        markNoteSwitch('noteRead');
      } catch (error) {
        result = { error };
      }
      if (version !== loadVersion) return null;
      if (!options.isSavePending() && options.getEditorContent() === outgoing) return result;
      await options.flushSave();
      if (version !== loadVersion) return null;
    }
  }

  async function load(id: string | null): Promise<void> {
    const version = ++loadVersion;
    await options.flushSave();
    markNoteSwitch('saveFlushed');
    if (version !== loadVersion) return;

    const read = id && id !== 'new' && hasFileSystem ? await readIncoming(id, version) : null;
    if (version !== loadVersion) return;

    options.patchState({ loading: true });
    options.clearTitleWarning();
    const noteBody = options.getNoteBody();
    if (noteBody) noteBody.scrollTop = 0;

    if (!id) {
      options.openNote(null, '');
      options.resetState();
      return;
    }

    options.patchState({ originalId: id !== 'new' ? id : null });
    if (id === 'new') {
      finishNewNote(version, getNextUntitledTitle(options.getNotes()));
      return;
    }
    if (!hasFileSystem || !read) {
      options.patchState({ loading: false });
      return;
    }

    try {
      if ('error' in read) throw read.error;
      const loadedContent = read.content;
      const slash = id.lastIndexOf('/');
      const fallbackTitle = slash === -1 ? id : id.slice(slash + 1);
      const title = getNoteById(id)?.title || fallbackTitle;
      options.patchState({
        title,
        content: loadedContent,
        savedContent: loadedContent,
        savedTitle: title,
      });
      options.openNote(id, loadedContent);
      markNoteSwitch('contentApplied');
      /* The editor's own serialization is the save baseline, because Milkdown
       * normalizes syntax on parse and the first real edit would otherwise look
       * like it rewrote the whole note. But an EMPTY serialization of a note
       * that has bytes is not a normalization — it is an editor that failed to
       * take the note (a parse that threw), and adopting it would declare the
       * note empty and make every later save write from that baseline.
       * 2026-09-03: that is how a note reached disk at 0 bytes. */
      const editorContent = options.getEditorContent();
      const editorTookTheNote = editorContent !== '' || loadedContent === '';
      if (editorContent !== undefined && editorContent !== loadedContent && editorTookTheNote) {
        options.patchState({ content: editorContent, savedContent: editorContent });
      }
      requestAnimationFrame(() => {
        if (version === loadVersion) options.autoResizeTitle();
      });
    } catch {
      if (version !== loadVersion) return;
      // Missing notes read as an empty string on every platform, so a broken
      // wikilink opens through the success path and is created on first save.
      // A rejection is a genuine backend read failure; never turn it into an
      // eager create that could resurrect a note deleted during sync.
      options.openNote(null, '');
      options.resetState();
      options.navigate('/');
      return;
    }
    options.patchState({ loading: false });
    markNoteSwitch('loadReturned');
  }

  function cancel(): void {
    loadVersion += 1;
  }

  return { load, cancel };
}
