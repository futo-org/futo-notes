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
 * - 4: clipboard image paste (saveImageData outbound message). Additive — a
 *      host that doesn't handle it just drops the message (paste is a no-op,
 *      nothing breaks); the toolbar Camera/Image picker is unaffected.
 * - 5: native-pasteboard clipboard image paste (pasteClipboardImage outbound
 *      message) for WebViews (iOS WKWebView) that hide the bitmap from the JS
 *      paste event, so no image File reaches `saveImageData`. Additive — a host
 *      that doesn't handle it just drops the message (paste is a no-op).
 * - 6: external-link follow (openUrl outbound message). A tap on a markdown
 *      link / autolink / bare URL posts the URL so the host opens it in the
 *      system browser — `window.open` is a no-op inside a WKWebView, and the
 *      native shells never let a non-editor URL load in the reused WebView.
 *      Additive — a host that doesn't handle it just drops the message (the tap
 *      is a no-op, exactly the pre-v6 behavior).
 */
export const BRIDGE_VERSION = 6 as const;

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
 * `@futo-notes/editor` IMAGE_EXTENSIONS), then calls
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
 * Emitted when the user pastes an image into the editor. The native WebViews
 * have no `saveImageBytes` of their own (that's a Tauri-desktop FS method), so
 * the embed reads the pasted image bytes and hands them to the host, which
 * saves them into the vault root — reusing the SAME save path as the
 * `pickImage` flow — then calls {@link FutoEditorApi.insertImage} with the
 * resulting filename. `data` is the image bytes base64-encoded (no `data:`
 * prefix); `ext` is the lowercased extension from `@futo-notes/editor`
 * `IMAGE_EXTENSIONS` (e.g. "png", "jpg").
 */
export interface SaveImageDataMessage {
  type: 'saveImageData';
  data: string;
  ext: string;
}

/**
 * Emitted when the user pastes an image but the WebView hid the bitmap from the
 * JS paste event (no image File — iOS WKWebView, like WebKitGTK), yet the paste
 * still `looksLikeImagePaste`. Carries no payload: a supporting host reads the
 * image off the NATIVE pasteboard (`UIPasteboard.general` on iOS), saves it into
 * the vault root through the SAME path as `saveImageData`/`pickImage`, then
 * calls {@link FutoEditorApi.insertImage} with the saved filename. Android's
 * Chromium WebView normally exposes the File and uses
 * {@link SaveImageDataMessage}; its host intentionally ignores this fallback.
 */
export interface PasteClipboardImageMessage {
  type: 'pasteClipboardImage';
}

/**
 * Emitted when the user taps an EXTERNAL link — a markdown link `[t](url)`, an
 * autolink `<url>`, or a bare URL. The host opens `url` in the system browser
 * (iOS `UIApplication.open`, Android `ACTION_VIEW`); it never loads inside the
 * editor WebView. Wikilinks use {@link OpenNoteMessage} instead — this is only
 * for links that leave the app. `url` is already normalized (a bare `www.…`
 * gains an `https://` scheme editor-side).
 */
export interface OpenUrlMessage {
  type: 'openUrl';
  url: string;
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
  | OpenUrlMessage
  | PickImageMessage
  | CursorContextMessage
  | SaveImageDataMessage
  | PasteClipboardImageMessage;

/**
 * Every `type` value {@link FutoEditorOutboundMessage} can carry. Consumed by
 * `scripts/gen-bridge-spec.ts` to generate the native coverage spec (Android:
 * `BridgeSpec.kt`, source of truth for the JUnit test asserting
 * `EditorWebView.kt` handles — or explicitly exempts — every type; iOS via
 * PKT-10). Also used below as a compile-time exhaustiveness check: if a
 * message type is added to (or removed from) the union without updating this
 * array, `_OutboundMessageTypesCoverExactly` fails to compile.
 */
export const OUTBOUND_MESSAGE_TYPES = [
  'ready',
  'change',
  'focus',
  'openNote',
  'openUrl',
  'pickImage',
  'cursorContext',
  'saveImageData',
  'pasteClipboardImage',
] as const;

// Distributive-conditional mutual-extends trick for exact type equality —
// robust for unions, unlike a plain `A extends B` check (which can pass for
// non-exact overlaps and miss both a missing and an extra member).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertTrue<T extends true> = T;
export type _OutboundMessageTypesCoverExactly = AssertTrue<
  Equals<(typeof OUTBOUND_MESSAGE_TYPES)[number], FutoEditorOutboundMessage['type']>
>;

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
