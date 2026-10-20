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

/** A page-monotonic revision of a vault-relative document. */
export interface DocumentRef {
  noteId: string;
  generation: number;
}
export interface DocumentLoadedMessage extends DocumentRef {
  type: 'documentLoaded';
  source: 'load' | 'external';
}
export interface EditedMessage extends DocumentRef {
  type: 'edited';
}
export type FlushFailureReason = 'noDocument' | 'loadFailed' | 'serializer';
export interface FlushFailedMessage extends DocumentRef {
  type: 'flushFailed';
  flushToken: string;
  reason: FlushFailureReason;
}
export interface ExternalRefusedMessage extends DocumentRef {
  type: 'externalRefused';
}

/** The serialized revision, debounced while typing and immediate on flush. */
export interface ChangeMessage extends DocumentRef {
  type: 'change';
  content: string;
  flushToken?: string;
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
 * Emitted when the cursor's context changes (deduped — only on actual
 * change). Drives the visibility of context-dependent NATIVE toolbar items
 * (Indent/Outdent). Hosts without a native toolbar can ignore it.
 */
export interface CursorContextMessage {
  type: 'cursorContext';
  /** The caret is in a LIST item specifically. Kept for hosts that only ever needed that. */
  onListLine: boolean;
  /**
   * The caret is in a list item OR a blockquote — the honest name for the
   * toolbar manifest's `when: 'inContainer'` visibility rule (see the
   * BRIDGE_VERSION doc comment above). Optional/additive: absent from an
   * older bundle, in which case a host falls back to {@link onListLine}.
   */
  inContainer?: boolean;
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
 * toolbar.ts, e.g. `'bold'`, `'heading-2'`, `'task-list'`) that cover the
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
 *
 * `disabled` is the subset of manifest ids that are currently INERT — today
 * only `'undo'`/`'redo'`, greyed and non-tappable while prosemirror-history's
 * `undoDepth`/`redoDepth` reports nothing to undo/redo. Deduped and emitted on
 * the exact same triggers as `active`, in the same message, so a host reads
 * both off one event rather than reconciling two.
 */
export interface FormatStateMessage {
  type: 'formatState';
  active: string[];
  disabled: string[];
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
 * Emitted after each active find recomputation or step. `current` is one-based
 * (zero only when there are no matches); `label` is the canonical display text
 * native bars render verbatim so count wording cannot drift across shells.
 */
export interface FindMatchesMessage extends DocumentRef {
  type: 'findMatches';
  /** Canonical active query, including a selection-seeded query on open. */
  query: string;
  current: number;
  total: number;
  label: string;
}
