import { hasFileSystem } from '$lib/platform';
import { sanitizeFilename } from '$lib/rules';
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
  navigate: (path: string) => void;
  patchState: (patch: NoteLoadPatch) => void;
  resetState: () => void;
  setEditorContent: (content: string) => void;
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
    options.setEditorContent('');
    requestAnimationFrame(() => {
      if (version !== loadVersion) return;
      options.autoResizeTitle();
      options.focusEditor();
    });
  }

  async function load(id: string | null): Promise<void> {
    const version = ++loadVersion;
    await options.flushSave();
    if (version !== loadVersion) return;

    options.patchState({ loading: true });
    options.clearTitleWarning();
    const noteBody = options.getNoteBody();
    if (noteBody) noteBody.scrollTop = 0;

    if (!id) {
      options.resetState();
      return;
    }

    options.patchState({ originalId: id !== 'new' ? id : null });
    if (id === 'new') {
      finishNewNote(version, getNextUntitledTitle(options.getNotes()));
      return;
    }
    if (!hasFileSystem) {
      options.patchState({ loading: false });
      return;
    }

    try {
      const loadedContent = await readNote(id);
      if (version !== loadVersion) return;
      const slash = id.lastIndexOf('/');
      const fallbackTitle = slash === -1 ? id : id.slice(slash + 1);
      const title = getNoteById(id)?.title || fallbackTitle;
      options.patchState({
        title,
        content: loadedContent,
        savedContent: loadedContent,
        savedTitle: title,
      });
      options.setEditorContent(loadedContent);
      const editorContent = options.getEditorContent();
      if (editorContent !== undefined && editorContent !== loadedContent) {
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
      options.resetState();
      options.navigate('/');
      return;
    }
    options.patchState({ loading: false });
  }

  function cancel(): void {
    loadVersion += 1;
  }

  return { load, cancel };
}
