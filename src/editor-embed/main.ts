// Embedded editor entry for the native-iOS spike.
//
// Mounts the REAL FUTO Notes MarkdownEditor.svelte into a bare HTML page and
// exposes the `window.FutoEditor` JS bridge consumed by the native Swift host
// (WKWebView). See the JS BRIDGE CONTRACT in the spike docs.
//
// The full app already runs under plain chromium for Playwright (no Tauri
// host), so MarkdownEditor's transitive imports detect "not Tauri" and fall
// back to browser behavior. The note universe starts empty; the host feeds it
// via FutoEditor.setNotes, and local images resolve against the base URL the
// host registers via FutoEditor.setImageBaseUrl.

import { mount } from 'svelte';
// app.css pulls in tailwind + @theme tokens + Barlow @font-face, and
// @imports components.css, markdown.css, and editor-ux.css — the same set
// the real app loads for the editor.
import '../styles/app.css';
import MarkdownEditor from '../components/MarkdownEditor.svelte';
import EmbedToolbar from './EmbedToolbar.svelte';
// The versioned editor↔host contract shared by the iOS, Android, and Tauri
// hosts. This file IMPLEMENTS that contract; the types are the source of truth.
import {
  BRIDGE_VERSION,
  postToHost,
  type AndroidFutoBridgeHost,
  type BridgeNote,
  type EditorTheme,
  type IosFutoBridgeHost,
  type FutoEditorApi,
} from '@futo-notes/editor';
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SetEditorContentOptions } from '../lib/editorContentSync';
import { getAllNotes, setNotesUniverse } from '../lib/notes.svelte';
import { resolveWikilink } from '../lib/wikilinks';
import { preloadImages, setLocalImageBaseUrl } from '../lib/liveMarkdownTransform';
import type { NotePreview } from '../types';

// ---------------------------------------------------------------------------
// Native bridge
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    // iOS: WKScriptMessageHandler.
    webkit?: {
      messageHandlers?: {
        futoBridge?: IosFutoBridgeHost;
      };
    };
    // Android: injected @JavascriptInterface (JSON-string payload).
    futoBridge?: AndroidFutoBridgeHost;
    FutoEditor?: FutoEditorApi;
  }
}

// Routes to whichever host transport is present (iOS object / Android JSON
// string); a no-op in a plain browser (Playwright / factory-judge).
const post = postToHost;

// Initial theme.
document.documentElement.dataset.theme = 'light';

// ---------------------------------------------------------------------------
// Mount the editor
// ---------------------------------------------------------------------------

// When true, the next onchange from the editor is the echo of a setContent()
// we just performed — swallow it so the native side doesn't get a redundant
// 'change' (which would round-trip back into a save → load → change loop).
let suppressNextChange = false;

const target = document.getElementById('editor');
if (!target) {
  throw new Error('editor-embed: #editor mount point not found');
}

// The toolbar mounts after the editor but is referenced from its callbacks
// (focus/cursor-context fire on events, never during the synchronous mount).
let toolbar: {
  setFocused: (focused: boolean) => void;
  setCursorContext: (onListLine: boolean) => void;
} | null = null;

// mount() returns an object exposing the component's `export function`s
// (setContent / getContent / focus / ...) plus its props.
const editor = mount(MarkdownEditor, {
  target,
  props: {
    content: '',
    onchange: (_content: string) => {
      // The editor already coalesces doc changes via requestAnimationFrame
      // before invoking onchange, so we post directly.
      if (suppressNextChange) {
        suppressNextChange = false;
        return;
      }
      post({ type: 'change', content: editor.getContent() });
    },
    onfocuschange: (focused: boolean) => {
      toolbar?.setFocused(focused);
      post({ type: 'focus', focused });
    },
    oncursorcontext: (ctx: { onListLine: boolean }) => {
      toolbar?.setCursorContext(ctx.onListLine);
    },
    onopenlink: (title: string, _event: MouseEvent) => {
      // Resolve the raw wikilink target against the host-fed universe; only
      // RESOLVED links navigate — taps on broken links do nothing.
      const resolved = resolveWikilink(title, getAllNotes().map((n) => n.id));
      if (resolved !== null) {
        post({ type: 'openNote', id: resolved });
      }
    },
  },
}) as unknown as {
  setContent: (text: string, options?: SetEditorContentOptions) => void;
  getContent: () => string;
  focus: () => void;
  blur: () => void;
  refreshDecorations: () => void;
  getView: () => EditorView | null;
};

// ---------------------------------------------------------------------------
// Mount the toolbar (native-shell markdown toolbar, docked above the keyboard)
// ---------------------------------------------------------------------------

const toolbarTarget = document.createElement('div');
document.body.appendChild(toolbarTarget);
toolbar = mount(EmbedToolbar, {
  target: toolbarTarget,
  props: {
    getView: () => editor.getView(),
    onpickimage: (source: 'camera' | 'library') => {
      post({ type: 'pickImage', source });
    },
    // Collapse chevron: blur the editor so the host's soft keyboard drops;
    // the resulting onfocuschange(false) hides the toolbar.
    ondismiss: () => editor.blur(),
  },
}) as unknown as {
  setFocused: (focused: boolean) => void;
  setCursorContext: (onListLine: boolean) => void;
};

// ---------------------------------------------------------------------------
// window.FutoEditor — the surface Swift calls via evaluateJavaScript
// ---------------------------------------------------------------------------

// Same options the desktop content $effect uses for external updates:
// keep selection/scroll, and keep the adopted text out of undo history so
// Cmd-Z after a sync doesn't restore pre-sync content.
const EXTERNAL_UPDATE_OPTS: SetEditorContentOptions = {
  preserveSelection: true,
  annotations: [Transaction.addToHistory.of(false)],
};

const futoEditor: FutoEditorApi = {
  setContent(markdown: string): void {
    const current = editor.getContent();
    // Only suppress the echo when the content actually changes — an identical
    // setContent is a no-op and won't produce an onchange to swallow.
    if (markdown !== current) {
      suppressNextChange = true;
    }
    // Full replacement: don't preserve selection (this is a load, not a sync).
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
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff');
    }
  },
  setNotes(notesJson: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(notesJson);
    } catch (err) {
      console.warn('FutoEditor.setNotes: malformed JSON, ignoring', err);
      return;
    }
    if (!Array.isArray(parsed)) {
      console.warn('FutoEditor.setNotes: expected a JSON array, ignoring');
      return;
    }
    const previews: NotePreview[] = (parsed as BridgeNote[]).map((n) => ({
      id: n.id,
      title: n.title,
      preview: '',
      modificationTime: n.modifiedMs,
      tags: n.tags ?? [],
    }));
    setNotesUniverse(previews);
    // Re-run the decoration pass so wikilink suffixes/broken-link styling in
    // the open doc track the new universe (same as the desktop shell does
    // from its notes-cache $effect).
    editor.refreshDecorations();
  },
  applyExternalContent(markdown: string): void {
    const current = editor.getContent();
    if (markdown !== current) {
      suppressNextChange = true;
    }
    // A sync, not a load: keep selection + scroll, suppress undo history.
    editor.setContent(markdown, EXTERNAL_UPDATE_OPTS);
  },
  insertImage(filename: string): void {
    const view = editor.getView();
    if (!view) return;
    const pos = view.state.selection.main.head;
    const insert = `![](${filename})\n`;
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
    });
    view.focus();
    // Warm the dimension cache (resolves via the registered image base) so
    // the image widget renders at its real size.
    preloadImages(insert, undefined, () => editor.getView());
  },
  setImageBaseUrl(base: string): void {
    setLocalImageBaseUrl(base);
    // Re-resolve local images already in the doc against the new base and
    // warm their dimension cache.
    preloadImages(editor.getContent() ?? '', undefined, () => editor.getView());
    editor.refreshDecorations();
  },
};
window.FutoEditor = futoEditor;

// NOTE: the empty-note keyboard (WKWebView refuses to raise the keyboard for an
// empty contenteditable) is handled NATIVELY in EditorWebView.swift by forcing
// WebKit's keyboardDisplayRequiresUserAction off — no JS primer hack needed.

// Signal readiness after the editor is mounted. requestAnimationFrame gives
// the CodeMirror view a frame to attach before native pushes initial content.
requestAnimationFrame(() => {
  post({ type: 'ready', version: BRIDGE_VERSION });
});

export {};
