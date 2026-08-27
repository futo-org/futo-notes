import type { EditorView } from '@codemirror/view';
import {
  createEditorHostBoot,
  postToHost,
  type BridgeNote,
  type EditorHostEffects,
  type EditorTheme,
  type FutoEditorApi,
} from '@futo-notes/editor';

import { preloadImages, setLocalImageBaseUrl } from '$features/editor/liveMarkdownTransform';
import { TOOLBAR_EXEC } from '$features/editor/markdownToolbar';
import {
  EXTERNAL_CONTENT_OPTS,
  type SetEditorContentOptions,
} from '$features/editor/editorContentSync';
import { setNotesUniverse } from '$features/notes/notes.svelte';
import type { NotePreview } from '$shared/types/note';
import { desktopLocalization } from '$shared/localization';

export interface EmbeddedEditorHandle {
  blur: () => void;
  focus: () => void;
  getContent: () => string;
  getView: () => EditorView | null;
  refreshDecorations: () => void;
  resetHistory: () => void;
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

  // The page-level effects the boot sequence drives. `hostBoot` decides WHEN
  // each runs and whether it runs at all; these only know HOW.
  const effects: EditorHostEffects = {
    applyLanguage(languageTag: string): void {
      desktopLocalization.setSelectedLanguageTag(languageTag);
    },
    applyContentPadding(px: number): void {
      // editor-native-layout.css reads this; the shells only supply the value.
      document.documentElement.style.setProperty('--futo-cm-pad-inline', `${px}px`);
    },
    applyNativeToolbar(enabled: boolean): void {
      options.setNativeToolbar(enabled);
    },
    applyTheme(theme: EditorTheme): void {
      document.documentElement.dataset.theme = theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff');
    },
    applyImageBaseUrl(base: string): void {
      setLocalImageBaseUrl(base);
      preloadImages(editor.getContent(), undefined, () => editor.getView());
      editor.refreshDecorations();
    },
    applyNotes(notesJson: string): void {
      const notes = parseBridgeNotes(notesJson);
      if (!notes) return;
      setNotesUniverse(notes);
      editor.refreshDecorations();
    },
    applyContent(markdown: string): void {
      if (markdown !== editor.getContent()) options.markExternalChange();
      editor.setContent(markdown, { preserveSelection: false });
    },
    readContent(): string {
      return editor.getContent();
    },
    post: postToHost,
  };

  const boot = createEditorHostBoot(effects);

  return {
    // Outside `boot` because its guards skip a note holding the text already on screen —
    // the reset has to run on every host open, not just the ones that change the document.
    initialize(configJson: string): void {
      boot.initialize(configJson);
      editor.resetHistory();
    },
    setContent(markdown: string): void {
      boot.setContent(markdown);
      editor.resetHistory();
    },
    getContent(): string {
      return editor.getContent();
    },
    focus(): void {
      editor.focus();
    },
    setTheme(theme: EditorTheme): void {
      boot.setTheme(theme);
    },
    setLanguage(languageTag: string): void {
      boot.setLanguage(languageTag);
    },
    setNotes(notesJson: string): void {
      boot.setNotes(notesJson);
    },
    applyExternalContent(markdown: string): void {
      if (markdown !== editor.getContent()) options.markExternalChange();
      editor.setContent(markdown, EXTERNAL_CONTENT_OPTS);
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
      boot.setImageBaseUrl(base);
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
