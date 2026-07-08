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
import { TOOLBAR_EXEC } from '../lib/markdownToolbar';
import { getAllNotes, setNotesUniverse } from '../lib/notes.svelte';
import { resolveWikilink } from '../lib/wikilinks';
import { preloadImages, setLocalImageBaseUrl } from '../lib/liveMarkdownTransform';
import { extFromMime, getImageFile, looksLikeImagePaste } from '../lib/imagePaste';
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

// True when a native host (iOS/Android) is present to service outbound
// messages. In a plain browser (the marketing-site embed, Playwright,
// factory-judge) there is none, so pickImage would post into the void and the
// camera / library toolbar buttons would be dead.
function hasNativeHost(): boolean {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { futoBridge?: unknown } };
    futoBridge?: unknown;
  };
  return Boolean(w.webkit?.messageHandlers?.futoBridge || w.futoBridge);
}

// Browser fallback for the camera / library buttons when no native host is
// present: a standard file <input> (the camera variant adds `capture` so
// phones open the camera directly), reading the chosen file as a data: URL
// the editor renders inline (resolveImageSrc passes data:/http(s) through).
function pickImageInBrowser(source: 'camera' | 'library'): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (source === 'camera') input.setAttribute('capture', 'environment');
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        futoEditor.insertImage(reader.result);
        editor.focus();
      }
    };
    reader.readAsDataURL(file);
  });
  document.body.appendChild(input);
  input.click();
}

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

// True once the host declares it renders its OWN toolbar (setNativeToolbar):
// the embed's web toolbar stays hidden and the host drives formatting through
// exec()/blur(), informed by the cursorContext messages below.
let nativeToolbar = false;

// cursorContext is deduped — only an actual flip crosses the bridge.
let lastPostedOnListLine: boolean | null = null;

// mount() returns an object exposing the component's `export function`s
// (setContent / getContent / focus / ...) plus its props.
const editor = mount(MarkdownEditor, {
  target,
  props: {
    content: '',
    // This is the native shell's WebView (no Tauri runtime → `isMobile` is
    // false here); tell the editor so it enables behavior for the case where CM6
    // owns its own scroller, such as height-map warming.
    nativeShell: true,
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
      if (!nativeToolbar) toolbar?.setFocused(focused);
      post({ type: 'focus', focused });
    },
    oncursorcontext: (ctx: { onListLine: boolean }) => {
      if (!nativeToolbar) toolbar?.setCursorContext(ctx.onListLine);
      if (ctx.onListLine !== lastPostedOnListLine) {
        lastPostedOnListLine = ctx.onListLine;
        post({ type: 'cursorContext', onListLine: ctx.onListLine });
      }
    },
    onopenlink: (title: string, _event: MouseEvent) => {
      // Resolve the raw wikilink target against the host-fed universe; only
      // RESOLVED links navigate — taps on broken links do nothing.
      const resolved = resolveWikilink(
        title,
        getAllNotes().map((n) => n.id),
      );
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
  warmScroll: () => { grew: number; steps: number } | null;
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
      if (hasNativeHost()) {
        post({ type: 'pickImage', source });
      } else {
        pickImageInBrowser(source);
      }
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
// Clipboard image paste (native shells)
// ---------------------------------------------------------------------------

// The shared `imagePasteHandler` (inside MarkdownEditor) only fires on Tauri —
// it needs `getFS().saveImageBytes`, which the native WebView's web FS lacks.
// So handle paste here: when a native host is present and the paste carries an
// image file, read its bytes and hand them to the host via `saveImageData`.
// The host saves into the vault (same path as the Camera/Image picker) and
// calls `insertImage(filename)` back. Capture phase + stop so CodeMirror's
// built-in paste doesn't also run. Non-image pastes fall through untouched.
//
// Some WebViews (iOS WKWebView, like WebKitGTK on the desktop) HIDE the bitmap
// from the JS paste event — no image File — while the OS clipboard still holds
// it. When the paste merely `looksLikeImagePaste` (same heuristic the Tauri
// desktop uses → src/lib/imagePaste.ts), fall back to `pasteClipboardImage`:
// the host reads the image off the native pasteboard and saves it through the
// SAME vault path. Android/Chromium always exposes the File, so the File path
// above takes the paste there and this fallback never fires.
function handleNativeImagePaste(event: ClipboardEvent): void {
  if (!hasNativeHost()) return;
  const clipboardData = event.clipboardData;
  if (!clipboardData) return;
  const view = editor.getView();
  if (!view) return;
  const target = event.target as Node | null;
  const inEditor =
    (target && view.contentDOM.contains(target)) ||
    view.contentDOM.contains(document.activeElement);
  if (!inEditor) return;

  const file = getImageFile(clipboardData);
  if (file) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      // readAsDataURL gives "data:<mime>;base64,<bytes>" — strip the prefix.
      const comma = reader.result.indexOf(',');
      const data = comma >= 0 ? reader.result.slice(comma + 1) : reader.result;
      post({ type: 'saveImageData', data, ext: extFromMime(file.type) });
    };
    reader.readAsDataURL(file);
    return;
  }

  // No File exposed, but this looks like an image paste (the heuristic already
  // guards `text/plain` so a real text paste is never hijacked): ask the host
  // to read the bitmap off the native pasteboard. The host saves into the
  // vault and calls `insertImage(filename)` back, exactly like `saveImageData`.
  if (looksLikeImagePaste(clipboardData)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    post({ type: 'pasteClipboardImage' });
  }
}
document.addEventListener('paste', handleNativeImagePaste, true);

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
    nativeToolbar = enabled;
    // Native shells render the editor in a full-bleed WebView. On wide screens
    // (tablet / iPad) that leaves the text left-aligned with large empty space,
    // so constrain it to a centered reading column (see .futo-native in
    // editor-ux.css). Phones are narrower than the cap → no-op there. Only the
    // native shells call setNativeToolbar, so desktop and the markdown-spec
    // tests keep the original full-width layout.
    document.documentElement.classList.toggle('futo-native', enabled);
    // If the web toolbar is currently up (host enabled mid-focus), drop it.
    if (enabled) toolbar?.setFocused(false);
  },
};
window.FutoEditor = futoEditor;

// NOTE: the empty-note keyboard (WKWebView refuses to raise the keyboard for an
// empty contenteditable) is handled NATIVELY in EditorWebView.swift by forcing
// WebKit's keyboardDisplayRequiresUserAction off — no JS primer hack needed.

// Eagerly decode Barlow now, before any note text renders. The native editor
// WebView is PREWARMED EMPTY, so with `font-display: swap` Barlow would
// otherwise only begin decoding when the first note's content renders — and
// swap in mid-view, changing every line's metrics. CM6 then re-measures and
// jerks the scroll position (a visible "jump" while scrolling). Decoding all
// weights up front (during prewarm, before content) means the editor measures
// in Barlow from the first frame; the re-measure when the loads settle covers
// the race where content arrived first. See docs/learnings/hr-scroll-jank.md.
function warmEditorFonts(): void {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return;
  const weights = ['400', '500', '600', '700'];
  const specs = [
    ...weights.map((w) => `${w} 18px Barlow`),
    'italic 400 18px Barlow',
    'italic 700 18px Barlow',
  ];
  Promise.allSettled(specs.map((s) => fonts.load(s))).then(() => {
    // If content was already pushed and measured against the fallback metrics,
    // re-warm now that Barlow is decoded: the swap changes every line's height,
    // which would otherwise re-introduce the anchor-correction jank on first
    // scroll. warmScroll re-measures the whole doc so the map is correct up front.
    editor.warmScroll();
  });
}
warmEditorFonts();

// Diagnostic hook: force a height-map warm and report how far the height map was
// off (grew = px of estimation error eliminated = the scroll-jank magnitude that
// would otherwise surface as a momentum-killing anchor correction). A second
// call should return grew≈0, confirming the map stays warm. Used by the iOS
// scroll-jank probe (see /tmp/build-scroll-probe.mjs).
(window as unknown as { __scrollDiag?: () => unknown }).__scrollDiag = () => editor.warmScroll();

// Signal readiness after the editor is mounted. requestAnimationFrame gives
// the CodeMirror view a frame to attach before native pushes initial content.
requestAnimationFrame(() => {
  post({ type: 'ready', version: BRIDGE_VERSION });
});

export {};
