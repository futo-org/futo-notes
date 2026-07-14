// Embedded editor entry for the native iOS/Android shells.
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
import '../styles/app.css';
import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
import EmbedToolbar from './EmbedToolbar.svelte';
import { BRIDGE_VERSION, postToHost, type FutoEditorApi } from '@futo-notes/editor';
import { getAllNotes } from '../features/notes/notes.svelte';
import { resolveWikilink } from '$shared/note/wikilinks';
import { hasNativeHost, pickImageInBrowser } from './hostBridge';
import { installNativeImagePaste } from './installNativeImagePaste';
import { warmEditorFonts } from './warmEditorFonts';
import {
  createFutoEditorApi,
  type EmbeddedEditorHandle,
  type EmbeddedToolbarHandle,
} from './createFutoEditorApi';

declare global {
  interface Window {
    FutoEditor?: FutoEditorApi;
  }
}

const post = postToHost;
document.documentElement.dataset.theme = 'light';

let suppressNextChange = false;

const target = document.getElementById('editor');
if (!target) {
  throw new Error('editor-embed: #editor mount point not found');
}

let toolbar: EmbeddedToolbarHandle | null = null;

let nativeToolbar = false;

let lastPostedOnListLine: boolean | null = null;

const editor = mount(MarkdownEditor, {
  target,
  props: {
    content: '',
    nativeShell: true,
    onchange: (_content: string) => {
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
      const resolved = resolveWikilink(
        title,
        getAllNotes().map((n) => n.id),
      );
      if (resolved !== null) {
        post({ type: 'openNote', id: resolved });
      }
    },
    onopenurl: (url: string) => {
      if (hasNativeHost()) {
        post({ type: 'openUrl', url });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
  },
}) as unknown as EmbeddedEditorHandle;

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
        pickImageInBrowser(source, (dataUrl) => {
          futoEditor.insertImage(dataUrl);
          editor.focus();
        });
      }
    },
    ondismiss: () => editor.blur(),
  },
}) as unknown as EmbeddedToolbarHandle;

installNativeImagePaste(() => editor.getView());

const futoEditor = createFutoEditorApi({
  editor,
  markExternalChange: () => {
    suppressNextChange = true;
  },
  setNativeToolbar: (enabled) => {
    nativeToolbar = enabled;
    document.documentElement.classList.toggle('futo-native', enabled);
    if (enabled) toolbar?.setFocused(false);
  },
});
window.FutoEditor = futoEditor;

warmEditorFonts(() => editor.warmScroll());

(window as unknown as { __scrollDiag?: () => unknown }).__scrollDiag = () => editor.warmScroll();

requestAnimationFrame(() => {
  post({ type: 'ready', version: BRIDGE_VERSION });
});

export {};
