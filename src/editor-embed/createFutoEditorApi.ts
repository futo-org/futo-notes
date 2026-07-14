import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { BridgeNote, EditorTheme, FutoEditorApi } from '@futo-notes/editor';

import { preloadImages, setLocalImageBaseUrl } from '$features/editor/liveMarkdownTransform';
import { TOOLBAR_EXEC } from '$features/editor/markdownToolbar';
import type { SetEditorContentOptions } from '$features/editor/editorContentSync';
import { setNotesUniverse } from '$features/notes/notes.svelte';
import type { NotePreview } from '$shared/types/note';

export interface EmbeddedEditorHandle {
  blur: () => void;
  focus: () => void;
  getContent: () => string;
  getView: () => EditorView | null;
  refreshDecorations: () => void;
  setContent: (text: string, options?: SetEditorContentOptions) => void;
  warmScroll: () => { grew: number; steps: number } | null;
}

export interface EmbeddedToolbarHandle {
  setCursorContext: (onListLine: boolean) => void;
  setFocused: (focused: boolean) => void;
}

interface CreateFutoEditorApiOptions {
  editor: EmbeddedEditorHandle;
  markExternalChange: () => void;
  setNativeToolbar: (enabled: boolean) => void;
}

const EXTERNAL_UPDATE_OPTIONS: SetEditorContentOptions = {
  preserveSelection: true,
  annotations: [Transaction.addToHistory.of(false)],
};

function parseBridgeNotes(notesJson: string): NotePreview[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(notesJson);
  } catch (error) {
    console.warn('FutoEditor.setNotes: malformed JSON, ignoring', error);
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.warn('FutoEditor.setNotes: expected a JSON array, ignoring');
    return null;
  }

  return (parsed as BridgeNote[]).map((note) => ({
    id: note.id,
    title: note.title,
    preview: '',
    modificationTime: note.modifiedMs,
    tags: note.tags ?? [],
  }));
}

export function createFutoEditorApi(options: CreateFutoEditorApiOptions): FutoEditorApi {
  const { editor } = options;

  return {
    setContent(markdown: string): void {
      if (markdown !== editor.getContent()) options.markExternalChange();
      editor.setContent(markdown, { preserveSelection: false });
    },
    getContent(): string {
      return editor.getContent();
    },
    focus(): void {
      editor.focus();
    },
    setTheme(theme: EditorTheme): void {
      document.documentElement.dataset.theme = theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff');
    },
    setNotes(notesJson: string): void {
      const notes = parseBridgeNotes(notesJson);
      if (!notes) return;
      setNotesUniverse(notes);
      editor.refreshDecorations();
    },
    applyExternalContent(markdown: string): void {
      if (markdown !== editor.getContent()) options.markExternalChange();
      editor.setContent(markdown, EXTERNAL_UPDATE_OPTIONS);
    },
    insertImage(filename: string): void {
      const view = editor.getView();
      if (!view) return;
      const position = view.state.selection.main.head;
      const insert = `![](${filename})\n`;
      view.dispatch({
        changes: { from: position, insert },
        selection: { anchor: position + insert.length },
      });
      view.focus();
      preloadImages(insert, undefined, () => editor.getView());
    },
    setImageBaseUrl(base: string): void {
      setLocalImageBaseUrl(base);
      preloadImages(editor.getContent(), undefined, () => editor.getView());
      editor.refreshDecorations();
    },
    exec(commandId: string): void {
      const run = TOOLBAR_EXEC[commandId];
      if (!run) {
        console.warn(`FutoEditor.exec: unknown command id '${commandId}', ignoring`);
        return;
      }
      const view = editor.getView();
      if (view) run(view);
    },
    blur(): void {
      editor.blur();
    },
    setNativeToolbar(enabled: boolean): void {
      options.setNativeToolbar(enabled);
    },
  };
}
