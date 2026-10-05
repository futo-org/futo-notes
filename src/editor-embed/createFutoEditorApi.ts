import {
  createEditorHostBoot,
  imageReferenceMarkdown,
  postToHost,
  type BridgeNote,
  type EditorHostEffects,
  type EditorTheme,
  type FutoEditorApi,
} from '@futo-notes/editor';

import { setVaultImageBaseUrl } from '$features/images/vaultImageSrc';
import { setNotesUniverse } from '$features/notes/notes.svelte';
import type { NotePreview } from '$shared/types/note';
import { desktopLocalization } from '$shared/localization';

export interface EmbeddedEditorHandle {
  blur: () => void;
  captureContent: () => string | undefined;
  closeFind: () => void;
  focus: () => void;
  getContent: () => string;
  insertMarkdown: (text: string) => void;
  refreshDecorations: () => void;
  revealSelection: () => void;
  resetHistory: () => void;
  openFind: () => void;
  setContent: (text: string) => void;
  setFindOverlayInset: (bottomOverlayPx: number) => void;
  setFindQuery: (query: string) => void;
  stepFind: (direction: 1 | -1) => void;
  exec: (commandId: string) => boolean;
  /* The harness probe main.ts exposes for the editor gauntlet. */
  getProseMirrorView?: () => unknown;
}

export interface EmbeddedToolbarHandle {
  setCursorContext: (inContainer: boolean) => void;
  setFocused: (focused: boolean) => void;
  setActiveFormats: (active: string[], disabled: string[]) => void;
}

interface CreateFutoEditorApiOptions {
  editor: EmbeddedEditorHandle;
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
      // The shells only supply the value; nothing renders it today — no
      // stylesheet reads this variable since the CodeMirror editor was
      // removed. Recorded as a Gap in docs/spec/editor.md, so the variable
      // stays set and the bridge input keeps working.
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
      /* The image node views re-resolve themselves off this
       * (vaultImageView.ts subscribes to the same store), so there is nothing
       * for the editor to redraw here. */
      setVaultImageBaseUrl(base);
    },
    applyNotes(notesJson: string): void {
      const notes = parseBridgeNotes(notesJson);
      if (!notes) return;
      setNotesUniverse(notes);
      editor.refreshDecorations();
    },
    applyContent(markdown: string): void {
      editor.setContent(markdown);
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
      /* The bridge contract types this `string` (bridge.ts). The component
       * answers `undefined` before any note has ever reached it (every native
       * host calls `initialize`/`setContent` before it reads) and — since the
       * RC-17 hardening — when serializing an edited document throws. The
       * second case is coerced to '' here, and the native shells have no guard
       * against '' over a non-empty note: a known latent gap (RC-73 in
       * docs/plan/editor-release-hardening.md). No natural serializer throw is
       * known; closing it means answering `null` across the bridge. A note
       * whose parse FAILED comes back as the host's own bytes, not as ''.
       *
       * Every host read is an exit's capture of the note it is about to leave,
       * so it is the capturing read: nothing about this document is reported
       * after it returns (MilkdownEditor `captureContent`). */
      return editor.captureContent() ?? '';
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
      editor.setContent(markdown);
    },
    insertImage(filename: string): void {
      editor.insertMarkdown(imageReferenceMarkdown(filename));
    },
    setImageBaseUrl(base: string): void {
      boot.setImageBaseUrl(base);
    },
    openFind(): void {
      editor.openFind();
    },
    setFindOverlayInset(bottomOverlayPx: number): void {
      if (typeof bottomOverlayPx !== 'number' || !Number.isFinite(bottomOverlayPx)) {
        console.warn(
          `FutoEditor.setFindOverlayInset: expected a finite height, received '${bottomOverlayPx}', ignoring`,
        );
        return;
      }
      editor.setFindOverlayInset(Math.max(0, bottomOverlayPx));
    },
    setFindQuery(query: string): void {
      editor.setFindQuery(query);
    },
    stepFind(delta: number): void {
      if (delta !== -1 && delta !== 1) {
        console.warn(`FutoEditor.stepFind: expected -1 or 1, received '${delta}', ignoring`);
        return;
      }
      editor.stepFind(delta);
    },
    closeFind(): void {
      editor.closeFind();
    },
    exec(commandId: string): void {
      editor.exec(commandId);
    },
    blur(): void {
      editor.blur();
    },
    setNativeToolbar(enabled: boolean): void {
      options.setNativeToolbar(enabled);
    },
  };
}
