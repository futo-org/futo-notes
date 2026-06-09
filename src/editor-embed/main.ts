// Embedded editor entry for the native-iOS spike.
//
// Mounts the REAL FUTO Notes MarkdownEditor.svelte into a bare HTML page and
// exposes the `window.FutoEditor` JS bridge consumed by the native Swift host
// (WKWebView). See the JS BRIDGE CONTRACT in the spike docs.
//
// The full app already runs under plain chromium for Playwright (no Tauri
// host), so MarkdownEditor's transitive imports detect "not Tauri" and fall
// back to browser behavior. getAllNotes() is empty, image lookups no-op.

import { mount } from 'svelte';
// app.css pulls in tailwind + @theme tokens + Barlow @font-face, and
// @imports components.css, markdown.css, and editor-ux.css — the same set
// the real app loads for the editor.
import '../styles/app.css';
import MarkdownEditor from '../components/MarkdownEditor.svelte';
// The versioned editor↔host contract shared by the iOS, Android, and Tauri
// hosts. This file IMPLEMENTS that contract; the types are the source of truth.
import {
  BRIDGE_VERSION,
  postToHost,
  type AndroidFutoBridgeHost,
  type EditorTheme,
  type IosFutoBridgeHost,
  type FutoEditorApi,
} from '@futo-notes/editor';

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
      post({ type: 'focus', focused });
    },
  },
}) as unknown as {
  setContent: (text: string, options?: { preserveSelection?: boolean }) => void;
  getContent: () => string;
  focus: () => void;
};

// ---------------------------------------------------------------------------
// window.FutoEditor — the surface Swift calls via evaluateJavaScript
// ---------------------------------------------------------------------------

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
