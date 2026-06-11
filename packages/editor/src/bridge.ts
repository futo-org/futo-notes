/**
 * The futoBridge contract — the versioned interface between the embedded
 * CodeMirror editor (`editor.html`, built from `src/editor-embed/main.ts`) and
 * the two native WebView hosts that load it:
 *
 *   - iOS    — WKWebView, `loadFileURL(editor.html)`, calls `window.FutoEditor`
 *              via `evaluateJavaScript`, receives messages on the
 *              `futoBridge` `WKScriptMessageHandler`.
 *   - Android — Android WebView hosting the same `editor.html`, calls
 *              `window.FutoEditor` via `evaluateJavascript`, receives messages
 *              through a `@JavascriptInterface` named `futoBridge`.
 *
 * The Tauri desktop app does NOT use this bridge: it edits with
 * `MarkdownEditor.svelte` (CodeMirror in Svelte) directly, no embedded
 * `editor.html`. Only the native iOS/Android shells load the bundle.
 *
 * This file is the SINGLE SOURCE OF TRUTH for that contract. Both WebView hosts
 * depend on it. Bump {@link BRIDGE_VERSION} on any breaking change to the
 * message shapes or the {@link FutoEditorApi} surface, and have hosts assert
 * the version they received in the `ready` message.
 */

/**
 * Contract version. Bump on any breaking change to {@link FutoEditorApi} or
 * {@link FutoEditorOutboundMessage}. Carried in the `ready` message so a host
 * can refuse to drive an editor bundle it doesn't understand.
 *
 * - 1: initial contract (setContent/getContent/focus/setTheme;
 *      ready/change/focus outbound messages).
 * - 2: note universe + sync + images (setNotes/applyExternalContent/
 *      insertImage/setImageBaseUrl; openNote/pickImage outbound messages).
 * - 3: native toolbar (exec/blur/setNativeToolbar; cursorContext outbound
 *      message). Additive — a v2 host can drive a v3 bundle unchanged.
 */
export const BRIDGE_VERSION = 3 as const;

/** Editor color theme. */
export type EditorTheme = 'light' | 'dark';

/**
 * One entry of the note universe the host feeds the editor via
 * {@link FutoEditorApi.setNotes}. Mirrors the list metadata the native shells
 * already hold (id = vault-relative path sans `.md`).
 */
export interface BridgeNote {
  id: string;
  title: string;
  modifiedMs: number;
  tags?: string[];
}

/**
 * Host → editor surface, installed on `window.FutoEditor` by the editor
 * bundle. Hosts call these via `evaluateJavaScript` / `evaluateJavascript`.
 */
export interface FutoEditorApi {
  /** Replace the entire document. A load, not a sync — selection is reset. */
  setContent(markdown: string): void;
  /** Read the current document text. */
  getContent(): string;
  /** Focus the editor (and raise the soft keyboard where the host allows it). */
  focus(): void;
  /** Switch the editor theme. */
  setTheme(theme: EditorTheme): void;
  /**
   * Populate the editor's note universe — a JSON-serialized
   * {@link BridgeNote}`[]` (JS↔native can only pass strings). Feeds the
   * wikilink suffix resolver, autocomplete, and resolution, then refreshes
   * decorations. Malformed JSON is warned about and ignored.
   */
  setNotes(notesJson: string): void;
  /**
   * Adopt a remote sync update of the OPEN note: selection- and
   * scroll-preserving, history-suppressed — a sync, not a load (contrast
   * {@link setContent}).
   */
  applyExternalContent(markdown: string): void;
  /**
   * Insert `![](filename)\n` at the cursor. The host calls this after a
   * `pickImage` round-trip, once the picked image bytes are saved into the
   * vault root.
   */
  insertImage(filename: string): void;
  /**
   * Register the base URL local image filenames resolve against: `f` in
   * `![](f)` renders from `base + encodeURIComponent(f)`. iOS passes
   * `futo-asset:///`, Android passes `file://<notesRoot>/`.
   */
  setImageBaseUrl(base: string): void;
  /**
   * Run a shared toolbar command by manifest id (a NATIVE toolbar button was
   * tapped). `commandId` is the id of an `exec` item in the toolbar manifest
   * (`TOOLBAR_EXEC_IDS` in toolbar.ts); the command itself is the same
   * `markdownToolbar.ts` code every platform's toolbar runs. Unknown ids are
   * warned about and ignored.
   */
  exec(commandId: string): void;
  /**
   * Blur the editor — drops the soft keyboard (and any toolbar). The native
   * dismiss chevron calls this so the editor's focus state stays truthful
   * (a plain `endEditing` would hide the keyboard behind the editor's back).
   */
  blur(): void;
  /**
   * The host renders its OWN toolbar (driven by `exec`/`blur` and the
   * `cursorContext` message): suppress the embed's web toolbar so the user
   * never sees two. Idempotent; the embed defaults to its web toolbar.
   */
  setNativeToolbar(enabled: boolean): void;
}

/** Emitted once, after the editor mounts and is ready to receive content. */
export interface ReadyMessage {
  type: 'ready';
  /** {@link BRIDGE_VERSION} the bundle was built against. */
  version: number;
}

/** Emitted when the document changes (already rAF-coalesced by the editor). */
export interface ChangeMessage {
  type: 'change';
  content: string;
}

/** Emitted when the editor gains or loses focus. */
export interface FocusMessage {
  type: 'focus';
  focused: boolean;
}

/**
 * Emitted when the user taps a RESOLVED wikilink. `id` is the resolved note
 * id (vault-relative path sans `.md`) from the universe fed via
 * {@link FutoEditorApi.setNotes}; taps on broken links post nothing.
 */
export interface OpenNoteMessage {
  type: 'openNote';
  id: string;
}

/**
 * Emitted when the user taps a toolbar image button. The host opens the
 * native picker, saves the image bytes into the vault root (honoring
 * `@futo-notes/shared` IMAGE_EXTENSIONS), then calls
 * {@link FutoEditorApi.insertImage} with the saved filename.
 */
export interface PickImageMessage {
  type: 'pickImage';
  source: 'camera' | 'library';
}

/**
 * Emitted when the cursor's line context changes (deduped — only on actual
 * change). Drives the visibility of context-dependent NATIVE toolbar items
 * (Indent/Outdent show only on list lines). Hosts without a native toolbar
 * can ignore it.
 */
export interface CursorContextMessage {
  type: 'cursorContext';
  onListLine: boolean;
}

/**
 * Editor → host messages, posted to the host's `futoBridge` message handler.
 * Discriminated on `type`.
 */
export type FutoEditorOutboundMessage =
  | ReadyMessage
  | ChangeMessage
  | FocusMessage
  | OpenNoteMessage
  | PickImageMessage
  | CursorContextMessage;

/**
 * The iOS host message sink: `window.webkit.messageHandlers.futoBridge`, a
 * `WKScriptMessageHandler` whose `postMessage` accepts a structured object.
 */
export interface IosFutoBridgeHost {
  postMessage(message: FutoEditorOutboundMessage): void;
}

/**
 * The Android host message sink: an `@JavascriptInterface` injected as
 * `window.futoBridge`. JS↔Java can only pass primitives, so the payload is the
 * JSON-serialized {@link FutoEditorOutboundMessage}.
 */
export interface AndroidFutoBridgeHost {
  postMessage(json: string): void;
}

/**
 * Post an outbound message to whichever host transport is present — iOS
 * (WKScriptMessageHandler, structured object) or Android (`@JavascriptInterface`,
 * JSON string). No-op in a plain browser (Playwright / factory-judge) with no
 * host. Both native shells receive the SAME message shapes.
 */
export function postToHost(message: FutoEditorOutboundMessage): void {
  const w = globalThis as unknown as {
    webkit?: { messageHandlers?: { futoBridge?: IosFutoBridgeHost } };
    futoBridge?: AndroidFutoBridgeHost;
  };
  const ios = w.webkit?.messageHandlers?.futoBridge;
  if (ios) {
    ios.postMessage(message);
    return;
  }
  if (w.futoBridge && typeof w.futoBridge.postMessage === 'function') {
    w.futoBridge.postMessage(JSON.stringify(message));
  }
}
