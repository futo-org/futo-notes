/**
 * The futoBridge contract — the versioned interface between the embedded
 * Milkdown editor (`editor.html`, built from `src/editor-embed/main.ts`) and
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
 * `MilkdownEditor.svelte` directly, no embedded
 * `editor.html`. Only the native iOS/Android shells load the bundle.
 *
 * This file is the SINGLE SOURCE OF TRUTH for that contract. Both WebView hosts
 * depend on it. Bump {@link BRIDGE_VERSION} on any breaking change to the
 * message shapes or the {@link FutoEditorApi} surface, and have hosts assert
 * the version they received in the `ready` message.
 */

import type {
  ReadyMessage,
  InitializedMessage,
  BridgeVersionMismatchMessage,
  DocumentLoadedMessage,
  EditedMessage,
  FlushFailedMessage,
  ExternalRefusedMessage,
  ChangeMessage,
  FocusMessage,
  OpenNoteMessage,
  PickImageMessage,
  CursorContextMessage,
  SaveImageDataMessage,
  PasteClipboardImageMessage,
  OpenUrlMessage,
  FormatStateMessage,
  HapticMessage,
  BlockDragMessage,
  BlockPressMessage,
  FindMatchesMessage,
} from './bridgeMessages';

export * from './bridgeApi';
export * from './bridgeMessages';

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
 * - 8: native find-in-note bars (openFind/setFindQuery/stepFind/closeFind/
 *      setFindOverlayInset; findMatches outbound message). Additive — a v7
 *      host never calls the new methods and simply drops the new report.
 *      `setFindOverlayInset` joined this entry before v8 ever shipped (both
 *      halves land in the same MR), so it needs no v9 of its own: the bump
 *      precedent protects shipped hosts, and no host/bundle pair with a
 *      narrower v8 exists. Optional even within v8 — a host that never calls
 *      it gets overlay 0, correct for non-overlaying bars (Android's sibling
 *      layout).
 * - 9: BREAKING — document identity and flush replace native reads (#194/#244/#245).
 *      setContent/applyExternalContent name the note; getContent is removed;
 *      retarget relabels the open note in place.
 *      See commit c10fb812 and `git log --grep='bridge v9'`.
 *
 * `formatState` (Notion-style toolbar active-state — see
 * {@link FormatStateMessage}) is additive and ships WITHOUT a version bump: it
 * is emitted only by the Milkdown editor, which reaches users only when the
 * transition lands (docs/plan/milkdown-transition.md), and a host that doesn't
 * handle it just drops the message (no highlighting, exactly today's
 * behavior). Bumping BRIDGE_VERSION needs explicit sign-off (root AGENTS.md
 * §11) — the transition does not do it.
 *
 * `formatState`'s `disabled` field (QA-003, Undo/Redo grayed out when their
 * stacks are empty) shipped the SAME way, added to the message after it
 * already existed: a host that reads `active` and ignores `disabled` just
 * never grays anything out — exactly today's behavior for that host — so this
 * is additive too and needed no version bump either.
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
 * `touch-action`, `user-select`, canceling `selectstart`/`selectionchange`,
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
 *
 * `cursorContext`'s `inContainer` field ships the same way: additive, no
 * version bump. `onListLine` already told a host whether the caret sat in a
 * LIST item, which is what the native toolbars' `when: 'inContainer'`
 * visibility rule (Indent/Outdent) keyed on — so a caret sitting in a
 * blockquote instead never lit those buttons on either native shell, even
 * though the desktop selection toolbar's `changeBlockIndent`
 * (blockCommands.ts) already nests/un-nests a quote just fine (docs/spec/
 * editor.md "Indent/Outdent showing only on list lines"). `inContainer`
 * reports the manifest rule's actual condition — a list item OR a blockquote
 * — and `onListLine` is unchanged, for anything that genuinely needs
 * list-only semantics. A host that reads only `onListLine` keeps exactly
 * today's behavior, and both native hosts fall back to `onListLine` when
 * `inContainer` is absent — an older bundle meeting a newer host.
 */
export const BRIDGE_VERSION = 9 as const;

/**
 * Editor → host messages, posted to the host's `futoBridge` message handler.
 * Discriminated on `type`.
 */
export type FutoEditorOutboundMessage =
  | ReadyMessage
  | InitializedMessage
  | BridgeVersionMismatchMessage
  | DocumentLoadedMessage
  | EditedMessage
  | FlushFailedMessage
  | ExternalRefusedMessage
  | ChangeMessage
  | FocusMessage
  | OpenNoteMessage
  | OpenUrlMessage
  | FindMatchesMessage
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
  'documentLoaded',
  'edited',
  'flushFailed',
  'externalRefused',
  'change',
  'focus',
  'openNote',
  'openUrl',
  'findMatches',
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
