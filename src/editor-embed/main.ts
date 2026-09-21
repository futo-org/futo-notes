// Embedded editor entry for the native iOS/Android shells.
//
// Mounts the REAL FUTO Notes MilkdownEditor.svelte into a bare HTML page and
// exposes the `window.FutoEditor` JS bridge consumed by the native Swift host
// (WKWebView). See the futoBridge contract in packages/editor/src/bridge.ts.
//
// The full app already runs under plain chromium for Playwright (no Tauri
// host), so the editor's transitive imports detect "not Tauri" and fall
// back to browser behavior. The note universe starts empty; the host feeds it
// via FutoEditor.setNotes, and local images resolve against the base URL the
// host registers via FutoEditor.setImageBaseUrl.

import { mount } from 'svelte';
import '../styles/app.css';
import MilkdownEditor from '$features/editor/milkdown/MilkdownEditor.svelte';
import type { EditorLinkGesture } from '$features/editor/editorLinkGesture';
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

const target = document.getElementById('editor');
if (!target) {
  throw new Error('editor-embed: #editor mount point not found');
}

let toolbar: EmbeddedToolbarHandle | null = null;

let nativeToolbar = false;

let lastPostedOnListLine: boolean | null = null;
let lastPostedInContainer: boolean | null = null;

const query = new URLSearchParams(window.location.search);

const editor = mount(MilkdownEditor, {
  target,
  props: {
    content: '',
    nativeShell: true,
    onchange: (_content: string) => {
      // `undefined` is an editor that holds no note at all — there is nothing
      // to report, and posting '' would tell the shell to empty a file.
      const content = editor.getContent();
      if (content === undefined) return;
      post({ type: 'change', content });
    },
    onfocuschange: (focused: boolean) => {
      if (!nativeToolbar) toolbar?.setFocused(focused);
      post({ type: 'focus', focused });
    },
    oncursorcontext: (ctx: { onListLine: boolean; inContainer: boolean }) => {
      if (!nativeToolbar) toolbar?.setCursorContext(ctx.inContainer);
      if (ctx.onListLine !== lastPostedOnListLine || ctx.inContainer !== lastPostedInContainer) {
        lastPostedOnListLine = ctx.onListLine;
        lastPostedInContainer = ctx.inContainer;
        post({ type: 'cursorContext', onListLine: ctx.onListLine, inContainer: ctx.inContainer });
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
    // Same split as `oncursorcontext`: the web toolbar is driven directly, and
    // the message goes out for the native toolbars whether or not this build
    // renders one.
    onformatstate: (active: string[], disabled: string[]) => {
      if (!nativeToolbar) toolbar?.setActiveFormats(active, disabled);
      post({ type: 'formatState', active, disabled });
    },
    // The long-press block-drag path BOTH native shells mount (see
    // MilkdownEditor.svelte / mobileBlockDnd.ts); the browser build never calls
    // this prop — it keeps the ⠿ gutter handle.
    onhaptic: (kind: 'lift' | 'move' | 'drop') => {
      post({ type: 'haptic', kind });
    },
    // Same path, and on iOS the message the shell ACTS on rather than merely
    // reports: it suspends WKWebView's text-interaction gestures while a block
    // is airborne, because the page cannot stop the OS magnifier itself
    // (bridge.ts BlockDragMessage).
    onblockdrag: (active: boolean) => {
      post({ type: 'blockDrag', active });
    },
    // Same path, posted at TOUCH-DOWN rather than at the lift: a shell's
    // protection must not be conditional on the editor's 340ms timer winning a
    // race against its WebView's own long-press recogniser (WKWebView's fires
    // at ~655ms) (bridge.ts BlockPressMessage).
    onblockpress: (pressed: boolean) => {
      post({ type: 'blockPress', pressed });
    },
    onenginemounted: () => {
      window.__futoEditorMounted = true;
    },
  },
}) as unknown as EmbeddedEditorHandle;

/* Find in note was a CodeMirror feature (src/features/editor/find/, bridge v8)
 * and the Milkdown swap has not reimplemented it; docs/spec/editor.md's "Find
 * in note" section carries the gap. The bridge contract still declares the
 * calls, because both native shells ship bars that make them — so they are
 * inert here rather than a TypeError on an undefined method, and no
 * `findMatches` message is ever posted back. */
const findNotImplemented = (): void => {
  console.warn('FutoEditor: find in note is not implemented in the Milkdown editor yet');
};
Object.assign(editor, {
  openFind: findNotImplemented,
  closeFind: findNotImplemented,
  setFindOverlayInset: findNotImplemented,
  setFindQuery: findNotImplemented,
  stepFind: findNotImplemented,
} satisfies Pick<
  EmbeddedEditorHandle,
  'openFind' | 'closeFind' | 'setFindOverlayInset' | 'setFindQuery' | 'stepFind'
>);

const toolbarTarget = document.createElement('div');
document.body.appendChild(toolbarTarget);
toolbar = mount(EmbedToolbar, {
  target: toolbarTarget,
  props: {
    onexec: (commandId: string) => editor.exec(commandId),
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

const futoEditor = createFutoEditorApi({
  editor,
  setNativeToolbar: (enabled) => {
    nativeToolbar = enabled;
    document.documentElement.classList.toggle('futo-native', enabled);
    if (enabled) toolbar?.setFocused(false);
  },
});
window.FutoEditor = futoEditor;

warmEditorFonts();

/* Chunk-equivalence census (chunkCensusHook.ts). `?census` is not a URL any
 * shell loads — the native hosts open the bundle with no query string at all. */
if (query.has('census')) installChunkCensusHook(editor as unknown as ChunkCensusEditor);

/* Harness probe for the editor gauntlet's Milkdown adapter
 * (tests/editor-gauntlet/milkdownAdapter.ts). It drives these exact bundle
 * bytes over file://, so a test-only build would not be the thing under test.
 * See MilkdownEditor.getProseMirrorView for why the gauntlet needs the view. */
(window as unknown as { __futoProseMirrorView?: () => unknown }).__futoProseMirrorView = () =>
  editor.getProseMirrorView?.() ?? null;

requestAnimationFrame(() => {
  post({ type: 'ready', version: BRIDGE_VERSION });
});

export {};
