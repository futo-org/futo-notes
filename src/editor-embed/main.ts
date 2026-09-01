// Embedded editor entry for the native iOS/Android shells.
//
// Mounts the REAL FUTO Notes MarkdownEditor.svelte into a bare HTML page and
// exposes the `window.FutoEditor` JS bridge consumed by the native Swift host
// (WKWebView). See the futoBridge contract in packages/editor/src/bridge.ts.
//
// The full app already runs under plain chromium for Playwright (no Tauri
// host), so MarkdownEditor's transitive imports detect "not Tauri" and fall
// back to browser behavior. The note universe starts empty; the host feeds it
// via FutoEditor.setNotes, and local images resolve against the base URL the
// host registers via FutoEditor.setImageBaseUrl.

import { mount } from 'svelte';
import '../styles/app.css';
import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
import MilkdownEditor from '$features/editor/milkdown/MilkdownEditor.svelte';
import type { EditorLinkGesture } from '$features/editor/interactions/editorPointerInteractions';
import EmbedToolbar from './EmbedToolbar.svelte';
import {
  BRIDGE_VERSION,
  hasNativeBridgeHost,
  postToHost,
  type FutoEditorApi,
} from '@futo-notes/editor';
import { getAllNotes } from '../features/notes/notes.svelte';
import { resolveWikilink } from '$shared/note/wikilinks';
import {
  installChunkCensusHook,
  type ChunkCensusEditor,
} from '$features/editor/milkdown/chunkCensusHook';
import { pickImageInBrowser } from './hostBridge';
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
    /**
     * The editor engine came up — the Android WebView gate's whole question
     * (EditorEngineSupport.kt `ENGINE_PROBE_JS`, drift-registry
     * `editor-mounted-global`). A plain global rather than a futoBridge
     * message for the same reason as `__futoEngineUnsupported` in editor.html:
     * it answers for the case where the bundle is what went wrong, and a
     * message would bump BRIDGE_VERSION and oblige both hosts (M10) for a
     * signal only Android reads.
     *
     * `window.FutoEditor` used to stand in for this. It cannot: Milkdown's
     * `Editor.make().create()` is async, so the host API is published — and
     * `ready` posted — whether or not the engine came up behind it. A Chromium
     * 83 WebView showed a blank pane with no notice.
     */
    __futoEditorMounted?: boolean;
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

/* Milkdown is the default embedded editor while the transition is in flight
 * (docs/plan/milkdown-transition.md); `editor.html?cm` gets the shipping
 * CodeMirror live-preview editor back, and that switch dies with CM6 at the
 * swap. Both are statically imported so the bundle keeps its ES2020 target
 * (no top-level await). */
const query = new URLSearchParams(window.location.search);
const useCodeMirror = query.has('cm');
const EmbeddedEditor = (useCodeMirror ? MarkdownEditor : MilkdownEditor) as typeof MarkdownEditor;

const editor = mount(EmbeddedEditor, {
  target,
  props: {
    content: '',
    nativeShell: true,
    onchange: (_content: string) => {
      // The one-shot flag exists because CodeMirror reports the host's own
      // setContent as a change. Milkdown's markdownUpdated is debounced 200ms,
      // so MilkdownEditor suppresses its load echo internally instead — reading
      // the flag here too would swallow the user's FIRST real edit.
      if (useCodeMirror && suppressNextChange) {
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
    onopenlink: (title: string, _gesture: EditorLinkGesture) => {
      const resolved = resolveWikilink(
        title,
        getAllNotes().map((n) => n.id),
      );
      if (resolved !== null) {
        post({ type: 'openNote', id: resolved });
      }
    },
    onopenurl: (url: string) => {
      if (hasNativeBridgeHost()) {
        post({ type: 'openUrl', url });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    // Milkdown-only (see MilkdownEditor.svelte); the CodeMirror path (`?cm`)
    // never calls this prop, so it simply never posts formatState and no
    // toolbar shows an active state. Same split as `oncursorcontext`: the web
    // toolbar is driven directly, and the message goes out for the native
    // toolbars whether or not this build renders one.
    onformatstate: (active: string[]) => {
      if (!nativeToolbar) toolbar?.setActiveFormats(active);
      post({ type: 'formatState', active });
    },
    // Milkdown-only, iOS long-press block-drag path (see
    // MilkdownEditor.svelte / mobileBlockDnd.ts); the CodeMirror path (`?cm`)
    // and every non-iOS environment never call this prop.
    onhaptic: (kind: 'lift' | 'drop') => {
      post({ type: 'haptic', kind });
    },
    // Same path, and the message the iOS shell acts on rather than merely
    // reports: it suspends WKWebView's text-interaction gestures while a block
    // is airborne, because the page cannot stop the OS magnifier itself
    // (bridge.ts BlockDragMessage).
    onblockdrag: (active: boolean) => {
      post({ type: 'blockDrag', active });
    },
    onenginemounted: () => {
      window.__futoEditorMounted = true;
    },
  },
}) as unknown as EmbeddedEditorHandle;

const toolbarTarget = document.createElement('div');
document.body.appendChild(toolbarTarget);
toolbar = mount(EmbedToolbar, {
  target: toolbarTarget,
  props: {
    getView: () => editor.getView(),
    onexec: (commandId: string) => editor.exec?.(commandId) ?? false,
    onpickimage: (source: 'camera' | 'library') => {
      if (hasNativeBridgeHost()) {
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

/* Milkdown installs its own image paste through ProseMirror's `handlePaste`
 * prop (MilkdownEditor.svelte); this document-capture install exists only to
 * cut off CodeMirror's paste handling, and dies with CM6 at the swap. */
if (useCodeMirror) installNativeImagePaste(() => editor.getView());

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

/* Chunk-equivalence census (chunkCensusHook.ts). `?census` is not a URL any
 * shell loads — the native hosts open the bundle with no query string at all. */
if (query.has('census')) installChunkCensusHook(editor as unknown as ChunkCensusEditor);

(window as unknown as { __scrollDiag?: () => unknown }).__scrollDiag = () => editor.warmScroll();

/* Harness probe for the editor gauntlet's Milkdown adapter
 * (tests/editor-gauntlet/milkdownAdapter.ts). It drives these exact bundle
 * bytes over file://, so a test-only build would not be the thing under test.
 * Null under `?cm`, which has no ProseMirror view. See
 * MilkdownEditor.getProseMirrorView for why the gauntlet needs the view. */
(window as unknown as { __futoProseMirrorView?: () => unknown }).__futoProseMirrorView = () =>
  editor.getProseMirrorView?.() ?? null;

requestAnimationFrame(() => {
  post({ type: 'ready', version: BRIDGE_VERSION });
});

export {};
