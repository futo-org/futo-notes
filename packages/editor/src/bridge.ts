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
 * - 7: host-config boot (`initialize`; initialized/bridgeVersionMismatch
 *      outbound messages). BREAKING: the boot sequence a host used to perform
 *      itself — theme, image base URL, toolbar suppression, content padding,
 *      note universe, content, in whatever order that host chose — is now ONE
 *      `initialize(configJson)` call the bundle applies in its own canonical
 *      order (see `hostBoot.ts`). A v6 host would configure a v7 bundle only
 *      partially, and a v7 host's single `initialize` means nothing to a v6
 *      bundle, so both native hosts move together (M10).
 *
 * `formatState` (Notion-style toolbar active-state — see
 * {@link FormatStateMessage}) is additive and ships WITHOUT a version bump: it
 * is emitted only by the Milkdown editor, which reaches users only when the
 * transition lands (docs/plan/milkdown-transition.md), and a host that doesn't
 * handle it just drops the message (no highlighting, exactly today's
 * behavior). Bumping BRIDGE_VERSION needs explicit sign-off (root AGENTS.md
 * §11) — the transition does not do it.
 *
 * `haptic` (Notion-style block-drag feedback — see {@link HapticMessage})
 * ships the SAME way: additive, no version bump, emitted only by the Milkdown
 * editor's long-press block-drag path (`mobileBlockDnd.ts`), which BOTH native
 * shells mount (`blockDragMode.ts`). A host without a case for it just drops the
 * message (no haptic, exactly today's behavior).
 *
 * `blockDrag` ({@link BlockDragMessage}) is the third of that family, and on
 * iOS the one the page cannot do without: WKWebView's own long-press text
 * interaction — the magnifier loupe and the caret it drags — is a UIKit gesture
 * the page has no way to cancel (measured: neither `pointer-events`,
 * `touch-action`, `user-select`, cancelling `selectstart`/`selectionchange`,
 * nor `preventDefault()` on the touch stream stops it, because WebKit commits
 * to the gesture at touch-down). Only the shell that owns the WebView can
 * suspend it, so the editor reports when a block is airborne and the shell
 * decides what that means — which on Android is nothing at all (see
 * {@link BlockDragMessage}). Additive, no version bump: a host without a case
 * for it just drops the message and keeps exactly today's behavior — including
 * today's loupe.
 *
 * `blockPress` ({@link BlockPressMessage}) is `blockDrag`'s earlier half, and
 * ships the same way. `blockDrag` can only be posted once the editor's own
 * long-press timer has fired, which leaves the whole touch-down-to-lift window
 * unprotected: measured on iOS 26.5, WKWebView's text interaction fires at
 * ~655ms with the editable focused (loupe + caret) and ~700ms unfocused (word
 * selection), against the editor's 340ms lift — so nothing but the editor's own
 * timer firing on time stands between a press and the OS magnifier. `blockPress`
 * is posted at TOUCH-DOWN instead, so the shell can stand the OS gesture down
 * before it can win. Android needs the same window for a much smaller job — the
 * WebView's own long-press BUZZ, which lands 128-141ms after the editor's lift
 * (measured) — and gets it from the same message. Additive, no version bump, and
 * a host without a case for it keeps exactly the pre-`blockPress` behavior.
 */
export const BRIDGE_VERSION = 7 as const;

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
  /**
   * Configure the freshly-loaded page from the host, exactly once per page
   * load: the host's answer to the `ready` message it just received. `configJson`
   * is a JSON-serialized `EditorHostConfig` (see `hostBoot.ts`, which owns the
   * order the settings are applied in and the bridge-version policy). The bundle
   * replies with {@link InitializedMessage} when the note is on screen.
   *
   * Re-callable: after a WebView renderer death the host reloads the bundle and
   * answers the new `ready` with the same call, which restores the open note.
   * Throws on a malformed config — that is a host bug, not a user-facing state.
   */
  initialize(configJson: string): void;
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

/**
 * Emitted once, after the editor mounts and is ready to receive content. The
 * host's only correct response is {@link FutoEditorApi.initialize} — the bundle
 * shows nothing until it is configured.
 */
export interface ReadyMessage {
  type: 'ready';
  /** {@link BRIDGE_VERSION} the bundle was built against. */
  version: number;
}

/**
 * Emitted once per {@link FutoEditorApi.initialize}, after the whole host config
 * has been applied and the note is on screen. Hosts treat this — not `ready` —
 * as "this page is showing my note": it is the point where a shell may run its
 * own per-note follow-up (its ready callback, its auto-focus keyboard shim).
 */
export interface InitializedMessage {
  type: 'initialized';
  /** {@link BRIDGE_VERSION} the bundle was built against. */
  version: number;
}

/**
 * Emitted during {@link FutoEditorApi.initialize} when the host was built
 * against a different {@link BRIDGE_VERSION} than the bundle — in practice a
 * stale `editor.html` next to a newer native binary (or the reverse) on a
 * developer machine, since a shipped app carries both in one artifact.
 *
 * The bundle boots ANYWAY and this message is purely diagnostic. Refusing to
 * boot would turn a build-hygiene mistake into a permanently blank editor —
 * the app's core surface — which is strictly worse than driving a bundle whose
 * skew has been additive at every version since v2. Hosts log it (and may
 * surface it in a debug build); they must not use it to suppress the editor.
 */
export interface BridgeVersionMismatchMessage {
  type: 'bridgeVersionMismatch';
  /** The version the host declared in its config. */
  hostVersion: number;
  /** {@link BRIDGE_VERSION} the bundle was built against. */
  bundleVersion: number;
}

/** Emitted when the document changes (already rAF-coalesced by the editor). */
export interface ChangeMessage {
  type: 'change';
  content: string;
}

/**
 * Emitted when the editor gains or loses focus.
 *
 * `focused` means CodeMirror holds the caret — a host may treat `false` as a
 * real blur edge and act on it (both native shells settle a deferred open-note
 * adoption there). It is deliberately NOT "some node inside the editor is still
 * `document.activeElement`": an Android WebView leaves `activeElement` behind
 * when the page blurs, so that reading never reported a blur and stranded the
 * deferral. → `editorDomFocus.ts`, docs/spec/sync.md (open-note dispositions)
 */
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
 * Emitted deduped (only when the set actually changes) on every selection
 * change and content change, and again right after a native toolbar tap runs
 * its command (so a tap reflects immediately rather than waiting for the next
 * selection event). Drives Notion-style active-state highlighting on the
 * keyboard toolbar — each host tints the matching button. `active`
 * is the subset of toolbar-manifest exec ids (`TOOLBAR_EXEC_IDS` in
 * toolbar.ts, e.g. `'bold'`, `'heading'`, `'task-list'`) that cover the
 * current cursor/selection; a task-list item never reports `'bullet-list'`
 * even though it is schema-nested inside one, so the two buttons don't both
 * light up.
 *
 * Milkdown only (`MilkdownEditor.svelte`): the shipping CodeMirror editor
 * (`?cm`) never emits it, so a host that mounts that engine simply never sees
 * one and no button lights up. All three toolbar surfaces consume it —
 * `EditorToolbarState` on iOS, `EditorHost.activeFormats` on Android, and the
 * embed fallback's own `EmbedToolbar`. See {@link BRIDGE_VERSION}'s doc comment
 * for why this ships without a version bump.
 */
export interface FormatStateMessage {
  type: 'formatState';
  active: string[];
}

/**
 * Emitted by the iOS long-press mobile block-drag path (`mobileBlockDnd.ts`)
 * at the moments the interaction wants tactile feedback:
 *
 * - `'lift'` when a ~330-350ms hold picks the block up (the moment it visibly
 *   scales/shadows).
 * - `'move'` each time the drop indicator lands on a DIFFERENT top-level
 *   boundary while the finger travels — the tick that tells a thumb the block
 *   would land somewhere new without looking. Consecutive resolutions to the
 *   same boundary are silent, so the rate is "once per place", not once per
 *   pointermove.
 * - `'drop'` when a release COMMITS an actual reorder as one transaction. A
 *   release back at the source position is a true no-op (no transaction, no
 *   history entry) and posts no `'drop'` — see the module doc comment there.
 *
 * Emitted by BOTH native shells, which mount the same long-press block drag
 * (`blockDragMode.ts`); the desktop browser mounts the ⠿ gutter-handle drag
 * instead and never constructs this plugin, so there is no third consumer to
 * add. A host without a case for a kind just drops it, which is why `'move'`
 * needed no version bump: a host that only knows lift/drop keeps exactly its
 * old feel.
 */
export interface HapticMessage {
  type: 'haptic';
  kind: 'lift' | 'move' | 'drop';
}

/**
 * Emitted by the same long-press block-drag path (`mobileBlockDnd.ts`) when
 * a block LEAVES the page (`active: true`, at the lift) and again the moment
 * the gesture resolves in any way at all — committed reorder, drop back at the
 * source, or a cancel the system forced (`active: false`). Every exit posts it,
 * unlike `haptic`, which is silent on a no-op drop: a host that suspends
 * something for the duration of a drag must be told when the drag is over even
 * if nothing happened.
 *
 * What the iOS shell does with it: suspends the WebView's text-interaction
 * gestures, so the OS magnifier does not appear on top of the block being
 * dragged (see {@link BRIDGE_VERSION}'s doc comment).
 *
 * What the Android shell does with it: NOTHING, and that is a measurement, not
 * an oversight. On a moto g play 2023 (Android 13, System WebView 151), holding
 * a block still for 1.2-1.6s — editable focused and unfocused, five runs — drew
 * no word highlight, no selection handles, no floating Cut/Copy action mode and
 * no magnifier over the ghost. Chromium, unlike WebKit, lets the page keep the
 * defences `mobileBlockDnd.ts` already mounts (cancelled
 * `selectstart`/`contextmenu`, a re-collapsed selection, `preventDefault()` on
 * the drag's touch stream), so there is nothing left for the shell to stand
 * down. The one thing that DID leak is a haptic, and it arrives before any
 * lift, so the shell handles it from {@link BlockPressMessage} instead.
 */
export interface BlockDragMessage {
  type: 'blockDrag';
  /** True while a block is airborne. */
  active: boolean;
}

/**
 * Emitted by the same long-press block-drag path (`mobileBlockDnd.ts`) the
 * instant a finger lands on a block (`pressed: true`) and again the instant that
 * press resolves in ANY way (`pressed: false`) — it lifted, it was an ordinary
 * tap, it turned into a scroll, or the system took the touch away. Strictly
 * wider than {@link BlockDragMessage}: every `blockDrag true` is inside a
 * `blockPress true`, and a press that never lifts posts no `blockDrag` at all.
 *
 * What the iOS shell does with it: stands down WKWebView's DELAYED text
 * interaction (the loupe long press, the tap-and-a-half select) for the
 * duration of the press, while leaving the tap recognisers — the ones that place
 * a caret and select a word — alone. That is the difference from `blockDrag`,
 * which suspends the whole text-interaction stack and the
 * `isTextInteractionEnabled` preference with it; that is safe only once the
 * gesture is known to be a drag, and it arrives 340ms too late to be the only
 * defence (see {@link BRIDGE_VERSION}'s doc comment for the measured numbers).
 *
 * What the Android shell does with it: silences the WebView's OWN long-press
 * haptic for the duration of the press, and nothing else. Chromium's
 * long-press recogniser trips around touch-down + 480ms — 128-141ms after the
 * editor's 340ms lift, measured over five holds on a moto g play 2023 (Android
 * 13, System WebView 151) — so without this the user feels two impacts a
 * seventh of a second apart instead of one pickup. Its VISIBLE half needs no
 * suspension at all (see {@link BlockDragMessage}), which is why Android acts
 * on this message and not on that one.
 *
 * Every `true` is matched by exactly one `false` from the plugin's single
 * disarm path: a host that suspends anything on `true` and is never told the
 * press ended would leave the editor unselectable — or, on Android, mute — for
 * the rest of the session. Both shells therefore also reset on page load, for
 * the press that a dying page never resolves.
 */
export interface BlockPressMessage {
  type: 'blockPress';
  /** True while a finger is down on a block and the press may still lift it. */
  pressed: boolean;
}

/**
 * Editor → host messages, posted to the host's `futoBridge` message handler.
 * Discriminated on `type`.
 */
export type FutoEditorOutboundMessage =
  | ReadyMessage
  | InitializedMessage
  | BridgeVersionMismatchMessage
  | ChangeMessage
  | FocusMessage
  | OpenNoteMessage
  | OpenUrlMessage
  | PickImageMessage
  | CursorContextMessage
  | SaveImageDataMessage
  | PasteClipboardImageMessage
  | FormatStateMessage
  | HapticMessage
  | BlockDragMessage
  | BlockPressMessage;

/**
 * Every `type` value {@link FutoEditorOutboundMessage} can carry. Consumed by
 * `scripts/gen-bridge-spec.ts` to generate the native coverage specs. Android's
 * JUnit test asserts `EditorWebView.kt` handles — or explicitly exempts — every
 * type; Swift switches exhaustively over its generated enum. Also used below
 * as a compile-time exhaustiveness check: if a
 * message type is added to (or removed from) the union without updating this
 * array, `_OutboundMessageTypesCoverExactly` fails to compile.
 */
export const OUTBOUND_MESSAGE_TYPES = [
  'ready',
  'initialized',
  'bridgeVersionMismatch',
  'change',
  'focus',
  'openNote',
  'openUrl',
  'pickImage',
  'cursorContext',
  'saveImageData',
  'pasteClipboardImage',
  'formatState',
  'haptic',
  'blockDrag',
  'blockPress',
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
 * JSON string). No-op in a plain browser (Playwright) with no host. Both
 * native shells receive the SAME message shapes.
 */
export function postToHost(message: FutoEditorOutboundMessage): void {
  const { ios, android } = bridgeHosts();
  if (ios) {
    ios.postMessage(message);
    return;
  }
  if (android) android.postMessage(JSON.stringify(message));
}

/**
 * Whether a native host is listening at all — i.e. whether {@link postToHost}
 * reaches anyone. The bundle also runs with no host (Playwright,
 * `pnpm run dev` in a browser), and behavior that only makes
 * sense with a host to answer it — image paste hands the bytes to the shell and
 * waits for `insertImage` back — must not be armed there.
 */
export function hasNativeBridgeHost(): boolean {
  const { ios, android } = bridgeHosts();
  return Boolean(ios ?? android);
}

function bridgeHosts(): {
  ios: IosFutoBridgeHost | undefined;
  android: AndroidFutoBridgeHost | undefined;
} {
  const w = globalThis as unknown as {
    webkit?: { messageHandlers?: { futoBridge?: IosFutoBridgeHost } };
    futoBridge?: AndroidFutoBridgeHost;
  };
  const android = w.futoBridge;
  return {
    ios: w.webkit?.messageHandlers?.futoBridge,
    android: android && typeof android.postMessage === 'function' ? android : undefined,
  };
}
