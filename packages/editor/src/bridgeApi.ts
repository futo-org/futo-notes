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
  setContent(noteId: string, markdown: string): void;
  /**
   * The open note `fromId` now lives at `toId` (rename, parked conflict copy, a
   * peer's rename): relabel the live document — caret, undo history and any
   * edit the host has not yet received kept — and report it through change
   * under `toId`. Ignored unless the editor holds `fromId`.
   */
  retarget(fromId: string, toId: string): void;
  /** Report the current document through change, echoing the request token. */
  flush(token: string): void;
  /** Focus the editor (and raise the soft keyboard where the host allows it). */
  focus(): void;
  /** Switch the editor theme. */
  setTheme(theme: EditorTheme): void;
  setLanguage(languageTag: string): void;
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
  applyExternalContent(noteId: string, markdown: string, expectedGeneration: number): void;
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
  /** Activate find and immediately report matches for the remembered query. */
  openFind(): void;
  /**
   * Declare the height, in CSS px, of host chrome drawn OVER the editor's
   * bottom edge, so find keeps the CURRENT match clear of it (docs/spec/
   * editor.md requires the current match to be visible). iOS docks its find bar
   * in a `.safeAreaInset` above a WebView that ignores the container's bottom
   * safe area, so the bar covers the strip a match would otherwise be revealed
   * into. Android does NOT call this: its bar is a sibling in the editor
   * Column above a weighted WebView, so the WebView never extends underneath
   * it — an inset there would scroll matches away from the bar for no reason.
   *
   * Optional and latched: a host that never calls it gets 0 — exactly the
   * pre-existing reveal — and a host that does reports only when its bar's
   * measured height changes, not on every open. Declaring it while find is
   * already open re-reveals the current match against the new margin, which is
   * what lets a shell report a height it only learns after laying the bar out.
   */
  setFindOverlayInset(bottomOverlayPx: number): void;
  /** Replace the active literal query and recompute matches. */
  setFindQuery(query: string): void;
  /** Step by exactly -1 or +1 while find is active. */
  stepFind(delta: number): void;
  /** Deactivate find, clear highlights, and restore the pre-find selection and viewport. */
  closeFind(): void;
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
