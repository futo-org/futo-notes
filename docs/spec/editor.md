# Editor — Spec

The editor is a shared CodeMirror 6 WebView — the **same `editor.html` /
`packages/editor` bytes on all platforms**. It renders Obsidian-style live
preview. Fine-grained decoration/cursor cases live in `markdown-spec/cases/`;
this file states the behaviors a human cares about.

## Theming

- The editor follows the app theme. Desktop applies `data-theme` directly; the
  native shells push it over the bridge (`FutoEditor.setTheme`) whenever the
  host theme changes.
- On the native shells the embed page paints **no background of its own**:
  `html`/`body` are transparent (editor.html, overriding app.css's
  `--color-bg`), and both hosts render the web view transparent (iOS
  `isOpaque = false` + `.clear`, Android `setBackgroundColor(TRANSPARENT)`),
  so the native app background (iOS `Theme.background`, Android Compose
  surface) shows through and the editor pane matches the surrounding UI in
  both light and dark. → editor.html, EditorWebView.swift, EditorWebView.kt

## Live preview

- Markdown markers (`*`, `#`, ` ``` `, `[[`, `]]`, …) are hidden on lines that
  don't contain the cursor, and revealed when the cursor enters that line. →
  markdown-spec/cases/10-cursor-reveal
- A blurred editor reveals nothing — all markers stay hidden.
- Reveal is per-line: moving the cursor onto a line reveals its markers; moving
  off re-hides them.

## Cursor

- **Tapping in the editor places the cursor at the tapped character** — not the
  start/end of the line or document.
- The first tap that opens the editor resolves the tapped CM line on `touchend`,
  focuses with `preventScroll`, then sets the selection — it must NOT use the
  native contenteditable tap-focus path, which scroll-jumps the whole app during
  keyboard presentation. → docs/learnings/ios-keyboard-editor-jump.md *(iOS)*
- Arrow up/down on a wrapped line moves by visual row, not logical line.
  Arrowing past a block widget (HR) lands in the adjacent paragraph, not inside
  the widget. → markdown-spec/cases/10-cursor-reveal
- Pressing Enter in a continued list item scrolls the new item into view (don't
  bypass CM's `scrollIntoView`). → docs/learnings/ios-keyboard-editor-jump.md
  *(iOS)*

## Markdown elements (rendered / decorated)

- Headings h1–h6, with inline emphasis / code / wikilinks inside.
- Emphasis: bold, italic, bold-italic, strikethrough — `*` and `_` markers.
- Code: inline (single and double backtick) and fenced (``` ``` ``` or `~~~`,
  with optional language).
- Links: `[text](url)`, autolinks `<url>`, and bare GFM URLs.
- Blockquotes including nested; the `>` marker is dimmed when the cursor is on
  the line.
- Lists: ordered, unordered, nested, and task checkboxes (checked / unchecked /
  uppercase `X`).
- A list item that wraps does **not** hanging-indent its continuation lines:
  wrapped lines start at the left margin — only the first visual line carries
  the nesting indent + marker. Applies to bullets, ordered items, and task
  items at every nesting depth, on every platform (spec decision 2026-06-10;
  wrapped text previously aligned under the first line's text). →
  liveMarkdownTransform.ts `cm-md-list-line` decorations
- Tables (GFM), horizontal rules, and images — rendered as block widgets.
  Each replace widget's `estimatedHeight` must equal its real rendered
  footprint (and the widget should render at a definite height) — otherwise
  CM6 re-sizes the off-screen gap when the element scrolls back into view and
  jerks the scroll position on iOS momentum scrolling. → docs/learnings/hr-scroll-jank.md
- On the native shells (iOS **and** Android — CM6 owns its own scroller), the
  editor warms CM6's height map on note load (and after font load / width change)
  by measuring every line's real height up front. Off-screen wrapped lines are
  otherwise estimated too short; the first scroll past them triggers a `scrollTop`
  anchor correction that cancels native touch momentum — the note "jumps forward
  and stops, no bounce" (measured up to 1436px on Android). Native overscroll
  affordance (`overscroll-behavior: contain` — iOS bounce / Android stretch) must
  be preserved. → src/lib/heightMapWarm.ts, docs/learnings/hr-scroll-jank.md
- Wikilinks `[[Title]]`.

## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. → markdown-spec/cases/09-tags, 13-adversarial
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized and hidden when the cursor is away.

## Tag bar *(desktop)*

The tag bar is a **desktop-only surface by decision (2026-06-09)** — mobile
native shells edit tags as text in the body, which is not a gap.

- A tag bar sits between the title and the editor: one chip per current tag,
  plus a "+ Tag" affordance. → NoteTagBar.svelte
- "+ Tag" opens an inline input with autocomplete over the vault's existing
  tags (case-insensitive); a non-matching entry shows a "Create #name" option.
  Enter or comma commits.
- Committing a tag writes it into the note's **leading header tag block**
  (creating the block when absent) — the tag is note content, not metadata.
- Removing a chip removes the tag; removing the last tag removes the entire
  header block.

## Wikilinks — navigation & integrity

- Clicking/tapping a wikilink navigates to the target note (desktop:
  Cmd/Ctrl+click opens it in a new tab). → NotesShell.svelte onopenlink
- A wikilink displays the **shortest unique path suffix** (`[[Projects/Roadmap]]`
  renders as "Roadmap" while unambiguous). The native shells feed the vault
  note list into the shared editor WebView over the bridge (`setNotes`), so
  the same resolver runs there (verified Android native + iOS simulator
  2026-06-09). → wikilinks.ts, packages/editor bridge v2,
  EditorWebView.kt / EditorWebView.swift
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path. Works on Tauri and both native shells (same embed; verified on
  emulator + simulator 2026-06-09). → wikilinkAutocomplete.ts
- A wikilink whose target does not resolve is still decorated, styled **broken**
  (`cm-md-link cm-md-wikilink cm-md-wikilink-broken`) — not undecorated, and
  **visually distinct from a resolved link** (muted/dimmed styling so a dead
  link is identifiable before tapping, not only by its no-op). The
  resolver (`resolveWikilink`) treats an **ambiguous** target (a bare filename
  matching more than one note) exactly like an absent one: both return `null` and
  render broken. On **desktop**, clicking a broken wikilink navigates to
  `/note/<target>`, which creates the target note on the fly (the documented
  create-on-missing path — **lazily**: a note session opens immediately, but the
  file is only written on the first body edit and appears in the sidebar then).
  The **native** shells no-op a broken tap: only a
  resolved link posts `openNote`. → liveMarkdownTransform.ts, wikilinks.ts
  `resolveWikilink`, noteSession.svelte.ts `loadNote` (create-on-missing),
  editor-embed/main.ts
- On the native shells, tapping a resolved wikilink navigates: the embed
  resolves the raw target against the pushed note list and posts `openNote`
  to the host, which swaps the open editor in place (Back returns to the
  list); a broken link posts nothing. Taps navigate via a dedicated
  `touchend` path — WebKit cancels the synthetic `click` after the handler's
  prevented `mousedown`, so a click-only handler dead-ends on iOS while
  Chromium double-fires; the touchend path covers both (verified Android
  native + iOS simulator 2026-06-09). On iOS the replaced nav entry needs an
  explicit `.id(noteId)` identity or SwiftUI reuses the editor view's @State
  from the previous note. → MarkdownEditor.svelte `wikilinkClickHandler`,
  NoteEditorScreen.kt / NoteEditorView.swift `openLinkedNote`
- **Renaming or moving a note rewrites every wikilink that points at it,
  across all notes** — including folder moves (`[[Markdown demo]]` →
  `[[Archive/Markdown demo]]`) and **self-referencing links inside the renamed
  note's own body** (a note linking to itself must not be left with a silently
  broken link after its own rename). → wikilinks.ts rewrite rules,
  notes.svelte.ts `rewriteWikilinksForRename`
- The relink rules also live in the shared Rust crate
  (futo-notes-model `wikilinks::{resolve_wikilink, shortest_unique_suffix,
  rewrite_wikilinks}` + `relink_note_references`), conformance-locked
  bit-for-bit against wikilinks.ts (tests/conformance/wikilinks.json). The
  native shells call `NoteStore.relink(old_id, new_id)` after every rename
  and move, so a rename on a native device rewrites backlinks vault-wide
  (verified on emulator + simulator 2026-06-09: bare-leaf and full-path
  links in other notes rewrote on disk). `[[target|alias]]` links are not
  rewritten — the TS rules treat the whole inner text as the target, and the
  Rust port pins that behavior. → futo-notes-model wikilinks.rs,
  futo-notes-ffi `NoteStore::relink`

## Interactive elements

- Tapping a task checkbox toggles `[ ]`/`[x]` in the source and autosaves —
  no cursor placement needed.
- Table cells are individually editable in place; Tab/Shift+Tab move between
  cells; Enter inserts a new row below the current one (so on the last row it
  appends); structure is revalidated on each edit. A cell context menu (desktop right-click) inserts/deletes rows/columns.
  → tableEditor.ts
- Pressing Enter in a list item continues the list (inherits nesting, auto
  numbers ordered items, renumbers on edit); Backspace at item start dedents;
  Backspace in an empty item deletes it. → listContinuation.ts
- Selecting text (desktop, single-line) raises a floating toolbar: Bold,
  Italic, Strikethrough, Code, Link. It hides for empty/multi-line selections
  and inside tables/code. → editorUX/selectionToolbar.ts *(desktop)*
- Typing `/` at the start of an empty block opens a block-command menu
  (headings, lists, tasks, quote, code, table, HR). Arrow keys move the
  highlight; a menu item activates on BOTH mouse click and Enter — the item
  must commit on the press (`mousedown`), because WebKit cancels the `click`
  that follows the menu's focus-guard `preventDefault`ed mousedown (same
  dead-end as the wikilink `touchend` note above). → editorUX/slashMenu.ts
  *(desktop)*

## Markdown toolbar *(native shells / mobile-width web editor)*

This surface exists on the native shells and the mobile-width **web** build
only. The Tauri **desktop** shell never shows it regardless of window size —
its platform module hardcodes `isMobile = false`, so there is no live
breakpoint that could reveal it. → src/lib/platform/index.ts

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Bold, Italic, Strikethrough, Heading, Quote, Bullet/Ordered/Task
  list, Indent/Outdent (shown when the cursor is on a list line), Camera,
  Image — horizontally scrollable, with a collapse chevron that blurs the
  editor (dropping both the keyboard and the toolbar). → MarkdownToolbar.svelte
- The toolbar SURFACE — items, order, grouping, accessibility labels,
  per-platform icons, visibility rules — is defined once in the
  `@futo-notes/editor` manifest, and the editing BEHAVIOR behind every
  button is defined once in markdownToolbar.ts (`TOOLBAR_EXEC`). Toolbars
  are dumb dispatchers: no platform restates the item list or reimplements
  a command. → packages/editor/src/toolbar.ts, src/lib/markdownToolbar.ts
- Native shells, toolbar chrome is NATIVE, commands are shared (bridge v3):
  the host renders its own toolbar from a GENERATED copy of the manifest and
  drives the editor over the bridge — `exec(id)` runs the shared command,
  the `cursorContext` message drives Indent/Outdent visibility, `blur()`
  backs the dismiss chevron, and `setNativeToolbar(true)` suppresses the
  embed's web toolbar so two never show. `just toolbar-spec` regenerates the
  native specs; `just toolbar-spec-check` (part of `just check`) fails when
  one drifts from the manifest. → packages/editor/src/bridge.ts,
  scripts/gen-toolbar-spec.ts
- iOS native: the toolbar is the keyboard's `inputAccessoryView` (generated
  ToolbarSpec.swift rendered by EditorToolbar.swift), replacing the stripped
  prev/next/Done bar — the system owns docking/animation with the keyboard.
  All buttons verified end-to-end on the iOS simulator 2026-06-10 (exec
  commands mutate the doc and autosave; Indent/Outdent appear only on list
  lines; pickers open natively; chevron blurs). → EditorToolbar.swift,
  EditorWebView.swift `futo_overrideInputAccessoryView`
- Android native: the toolbar is a Compose bar (generated ToolbarSpec.kt
  rendered by EditorToolbar.kt) docked above the soft keyboard via the editor
  screen's `imePadding`, shown only while the editor is focused (bridge
  `focus` message). All buttons verified end-to-end on the emulator
  2026-06-10 (exec commands mutate the doc and autosave; Indent/Outdent
  appear only on list lines; pickers open natively; chevron blurs, dropping
  keyboard + toolbar). → EditorToolbar.kt, NoteEditorScreen.kt,
  EditorWebView.kt `EditorHost`
- **Toolbar docking + height (both native shells).** The bar is exactly
  **44 pt** tall on iOS / **44 dp** on Android, its 36 pt/dp icons centered
  with ~4 pt top/bottom, and it sits **FLUSH against the top of the on-screen
  keyboard**: there is NO empty band between the toolbar icons and the
  keyboard's first row. Verified on the iOS simulator with the soft keyboard
  up 2026-06-18.
  - iOS is fragile here: as a keyboard `inputAccessoryView` hosted in a
    `UIHostingController`, the default behavior feeds the keyboard window's
    bottom safe-area (home-indicator, ~34 pt) inset into the hosted SwiftUI
    content, which pushes the icons up and opens a dead band below them. The
    flush dock is held by `ToolbarMetrics.barHeight` (single source for the
    44 pt across the SwiftUI frame, the container frame, and
    `intrinsicContentSize`) plus `UIHostingController.safeAreaRegions = []`.
    Do not remove the `safeAreaRegions` line, and re-check the simulator with
    the keyboard up after touching the accessory. This gap regressed in
    7c43a8e (web `visualViewport`-docked toolbar → native bar) and was
    re-closed 2026-06-18. → EditorToolbar.swift `ToolbarMetrics`,
    `EditorToolbarAccessory`
  - Android docks flush by construction: the 44 dp Compose bar is held above
    the keyboard by the screen's `imePadding`, so the inset tracks the
    keyboard with no gap. → EditorToolbar.kt, NoteEditorScreen.kt
- **Scroll affordance — "snapped peek" (both native shells).** When the items
  overflow, the trailing edge does NOT cut cleanly (which read as "nothing more
  here"): the bar measures the laid-out button positions + the viewport width
  and adds a trailing inset that clips whichever icon sits at the edge to ~55%,
  so a partial icon always peeks past the edge — the deterministic, same-on-
  every-width/density signal that the bar scrolls. A soft ~10 pt edge fade
  softens the clipped icon (and the leading edge once scrolled). Verified on the
  iOS simulator (iPhone 17 Pro 402 pt + Pro Max 440 pt) and the Android emulator
  2026-06-30 — a different edge icon is clipped per width, always to ~half. iOS
  derives the geometry from `onScrollGeometryChange`; Android from
  `onGloballyPositioned` (`positionInWindow`) + a measure-tick. → EditorToolbar.swift
  `computeSnap`, EditorToolbar.kt `computeToolbarSnapPx`
- Camera inserts a photo from the device camera or photo library; Image opens
  a file picker. Both save the image into the vault and insert `![](file)`.
  On the native shells the toolbar's Camera/Image buttons reach the host
  picker (web toolbar posts `pickImage`; the native iOS/Android toolbars
  invoke it directly), which presents the native picker (Photo Picker / camera intent
  on Android; PHPicker on iOS, camera falling back to the library on the
  simulator), saves the bytes into the vault root under a generated
  space-free name, and calls `insertImage` back into the embed.

## Images

- Pasting an image into the editor (desktop) saves it to the notes directory
  and inserts `![](filename)`; supported types follow
  `@futo-notes/shared` `IMAGE_EXTENSIONS`. Both clipboard shapes work: a raw
  bitmap (OS screenshot-to-clipboard) and a browser **Copy Image** (which the
  source app puts on the clipboard as an `<img>` `text/html` fragment plus a
  bitmap). When the paste event exposes an image file it is saved directly;
  otherwise the bitmap is read from the OS clipboard via the
  `fs_paste_clipboard_image` Tauri command. This native fallback is required on
  Linux/Wayland, where WebKitGTK hides the clipboard image from the JS paste
  event — a screenshot arrives with empty `items`, and a Copy Image arrives as
  a lone `text/html` item — so the gate is "no image file found and no
  `text/plain` to paste" (plain/rich-text pastes are left untouched).
  Verified on Linux (WebKitGTK) and Windows (WebView2), both image types,
  2026-06-22. → imagePaste.ts `handlePasteEvent` / `looksLikeImagePaste` /
  `pasteFromNativeClipboard`; core.rs `fs_paste_clipboard_image`
- Images render inline in live preview via the Tauri asset protocol, with a
  `readFile`→blob-URL fallback when the asset protocol can't actually decode an
  `<img>` (macOS WKWebView / Linux WebKitGTK answer the request but paint a
  blank white box; the gate is a real image-decode probe, not a HEAD probe).
  → tauri.ts `getImageUrl` / `assetUrlDecodes`. *(Tauri)*
- The native shells render local images inline through a host-registered
  image base URL (`setImageBaseUrl`): iOS serves the vault root through a
  `futo-asset://` WKURLSchemeHandler (path-traversal- and image-extension-
  guarded); Android serves `file://<vault root>/` directly. Insert path is
  the toolbar Camera/Image flow above; picked images save into the vault and
  render inline (verified end-to-end on emulator + simulator 2026-06-09).
  → EditorImages.swift `FutoAssetSchemeHandler`, ImagePicker.kt,
  liveMarkdownTransform.ts `setLocalImageBaseUrl`
- Inline image rendering depends on the referenced file existing in the vault.
  That file is delivered across devices by sync — the image binary syncs
  alongside its note, so `![](image-…)` resolves on every device, not just the
  one that created it. → [sync.md](sync.md) "Embedded images sync with their
  notes"
- The native shells ALSO support clipboard image paste. The native WebView has
  no `saveImageBytes` (that's a Tauri-desktop FS method), so the embed reads the
  pasted image bytes and hands them to the host via the `saveImageData` bridge
  message (base64 + extension); the host decodes and saves them into the vault
  through the SAME path as the Camera/Image picker, then calls
  `insertImage(filename)` — so a pasted image is indistinguishable from a picked
  one (`![](image-…ext)`, stored as a vault blob, no inline base64). Verified
  end-to-end on the Android emulator 2026-06-22. When the WebView hides the
  bitmap from the JS paste event (no File — WKWebView/WebKitGTK), the embed
  instead posts the payload-less `pasteClipboardImage` message (bridge contract
  v5) and the host reads the image off the native clipboard. → editor-embed/main.ts
  `handleNativeImagePaste`, bridge.ts `SaveImageDataMessage` /
  `PasteClipboardImageMessage` (contract v5), EditorWebView.kt + ImagePicker.kt
  `saveImageDataIntoVault` (Android), EditorWebView.swift `saveImageData` +
  `clipboardImageData` + EditorImages.swift `VaultImages.save` (iOS),
  fs_paste_clipboard_image (Tauri)

> **Gap:** Clipboard image paste is verified on Linux (WebKitGTK), Windows
> (WebView2), native Android (emulator, 2026-06-22), and **macOS desktop**
> (Tauri/WKWebView — real clipboard image + real Cmd+V through the
> `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback, verified in the
> 2026-07-02 full-spec QA pass). The iOS path is wired both ways: the embed
> posts `saveImageData` when WKWebView exposes the pasted image File, and falls
> back to the payload-less `pasteClipboardImage` (bridge contract v5) when
> WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()`
> then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and
> saves through `VaultImages.save`, the SAME vault path as the picker. Compiles
> clean (`just build-ios-native`). What remains is on-device end-to-end QA on
> **native iOS only**: copy a screenshot / "Copy Image", paste into the editor,
> confirm a vault blob + `![](image-…)` insert. (bridge added 2026-06-26)

## Code / fence isolation

- Wikilinks and tags inside inline code or fenced blocks are NOT decorated and
  NOT extracted. → markdown-spec/cases/03-code, 08-wikilinks, 09-tags

## Saving & rename *(native shells)*

- Body edits autosave on a debounce (~400 ms). The save re-reads the current
  note id at fire time, so a save landing **after** a rename writes to the
  renamed note, not a stale id. → NoteEditorScreen.kt / NoteEditorView.swift
  `scheduleSave`
- Title edits debounce (~500 ms) into a rename (iOS commits via the rename
  dialog instead). Before the file moves, any pending body save is flushed to
  the *current* id and the in-flight save is cancelled — otherwise a stale save
  recreates a ghost note at the old id (data loss). → NoteEditorScreen.kt /
  NoteEditorView.swift `commitRename`
- Leaving the editor flushes a pending save only if the content changed and the
  note still exists.
- Backgrounding the app flushes the open editor's pending edit before the OS
  can jetsam the process, so an edit caught inside the autosave debounce is not
  lost. → FutoNotesApp scenePhase `.inactive`/`.background` → NotesStore
  `flushPendingEditor` *(iOS)*
- An empty title shows the placeholder "Untitled"; the title field strips
  newlines.
- The editor chrome shows **no word count** (or any other document
  statistic) — just the title and the document (spec decision 2026-06-10;
  Android native previously rendered an "N words" line under the title, no
  other platform ever did). → NoteEditorScreen.kt
- On Tauri the same contract holds via the shared shell: the title is a
  textarea above the tag bar; edits debounce into a file rename and rewrite
  backlinks (see "Wikilinks — navigation & integrity"). Verified on Android
  Tauri 2026-06-09. Title-only edits use an aggressive ~10 s debounce (body
  edits keep ~500 ms) so a rename round-trip never fires mid-typing and clobbers
  in-flight keystrokes; moving focus into the editor body flushes the pending
  title save immediately. → `noteSession.svelte.ts` `debouncedSave`,
  `NotesShell.svelte` `handleEditorFocusChange`

## Android — IME

- Backspace on an empty note must not crash the WebView renderer. *(Android)*
  - *History (resolved):* Chromium 147's empty-editable surrounding-text path
    tripped a `CHECK()` (`SIGTRAP`) when FUTO Keyboard queried it on backspace.
    This was **fixed upstream by a FUTO Keyboard update**, so the in-app IME
    shield is no longer required. → docs/learnings/ime-shield-workaround.md
  - The in-app IME shield has been **removed** from the shared editor
    (`imeShieldPlugin` / `imeShield.ts`) and the `just verify-ime-shield` guard
    is gone. The native Compose app never carried it and is fine without it.
    (The `FutoImeConnection` / `EditorImeShield` Kotlin classes only ever lived
    in the gitignored generated Tauri-Android tree, which is no longer generated;
    the only surviving artifact is the `WRY_RUSTWEBVIEW_CLASS_EXTENSION` override
    in `apps/tauri/src-tauri/.cargo/config.toml`, still marked DO-NOT-REMOVE for
    the Tauri-Android build path.)
