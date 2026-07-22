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
  both light and dark. → editor.html, EditorWebView.swift, EditorWebView.kt,
  tests/editor-embed-bridge.spec.ts

## Live preview

- Markdown markers (`*`, `#`, ` ``` `, `[[`, `]]`, …) are hidden on lines that
  don't contain the cursor, and revealed when the cursor enters that line. →
  markdown-spec/cases/10-cursor-reveal
- A blurred editor reveals nothing — all markers stay hidden.
- Reveal is per-line: moving the cursor onto a line reveals its markers; moving
  off re-hides them.

## Cursor

- **Tapping in the editor places the cursor at the tapped character** — not the
  start/end of the line or document. → MarkdownEditor.svelte
- The first tap that opens the editor resolves the tapped CM line on `touchend`,
  focuses with `preventScroll`, then sets the selection — it must NOT use the
  native contenteditable tap-focus path, which scroll-jumps the whole app during
  keyboard presentation. → docs/learnings/ios-keyboard-editor-jump.md _(iOS)_
- **Tapping an UNFOCUSED editor places the caret at the tap AND raises the
  keyboard** — on refocus, WebKit and Blink restore the selection saved at
  blur (e.g. the header the cursor was on when the keyboard was dismissed,
  #24). The mechanism differs per engine: iOS intercepts the touchend
  (`iosTapFocus`, also dodging WKWebView's tap-focus scroll-jump); Android
  must let the NATIVE tap run — preventDefault-ing it suppresses the IME for
  a JS focus — and re-places the caret on click
  (`mobileTapCaretCorrection`, which also fixes Android Chrome dropping to
  position 0 on empty/widget lines — that fallback bites even while focused,
  so Android corrects ALL single taps; iOS focused taps are left to WebKit's
  native placement). The correction is anchored on the host-asserted
  `nativeShell` prop, never a UA-sniffed flag alone — pinned-false flags
  silently disabled tap paths in the native embeds twice. On a WRAPPED line
  the tap resolves within the tapped visual row (the tap's own y, clamped
  into the line box — never the line-rect midpoint, which yanked the caret
  to the middle row and made repeated corrective taps read as
  double/triple-tap selections). Double/triple-tap word/line selection stays
  native on both shells. → src/features/editor/iosTapFocus.ts, MarkdownEditor.svelte
- Arrow up/down on a wrapped line moves by visual row, not logical line.
  Arrowing past a block widget (HR) lands in the adjacent paragraph, not inside
  the widget. → markdown-spec/cases/10-cursor-reveal
- Pressing Enter in a continued list item scrolls the new item into view (don't
  bypass CM's `scrollIntoView`). → docs/learnings/ios-keyboard-editor-jump.md
  _(iOS)_
- Text selection is the platform's native selection. On the native shells the
  system owns it entirely (loupe, grab handles, callout) — the editor never
  re-dispatches or "snaps" the selection, so it must not fight the native
  handles. On desktop ONLY, a mouse drag-select that covers the visible content
  of a markdown element whose source markers are hidden snaps outward through
  those markers so copy/delete carry valid markdown; the pointer-selection
  listeners are disabled whenever `nativeShell` identifies the native embed.
  Verified on Android and iOS devices 2026-07-10.
  → MarkdownEditor.svelte (pointer-selection gate) _(native shells / desktop snap)_

## Markdown elements (rendered / decorated)

- Headings h1–h6, with inline emphasis / code / wikilinks inside.
- Emphasis: bold, italic, bold-italic, strikethrough — `*` and `_` markers.
- Code: inline (single and double backtick) and fenced (triple backticks or
  triple tildes, with optional language).
- Links: `[text](url)`, autolinks `<url>`, and bare GFM URLs.
- Blockquotes including nested; the `>` marker is dimmed when the cursor is on
  the line.
- Lists: ordered, unordered, nested, and task checkboxes (checked / unchecked /
  uppercase `X`).
- Tapping/clicking a bullet or number marker places the caret at the marker
  (revealing the dimmed `-`/`N.` source — the same state as arrowing onto
  it); a marker tap must never be a no-op. The markers are
  contenteditable=false widget spans, so the browser can't place a caret in
  them and CM's default `ignoreEvent() === true` would swallow the tap —
  both marker widgets return `false` (same contract as the HR widget).
  Checkbox and image widgets intentionally keep `true` + their own handlers
  (toggle / place-at-line-end). → live-preview/listDecorations.ts
  BulletWidget/NumberWidget, liveMarkdownTransform.decorations.test.ts
- A list item that wraps does **not** hanging-indent its continuation lines:
  wrapped lines start at the left margin — only the first visual line carries
  the nesting indent + marker. Applies to bullets, ordered items, and task
  items at every nesting depth, on every platform (spec decision 2026-06-10;
  wrapped text previously aligned under the first line's text). →
  live-preview/listDecorations.ts `cm-md-list-line` decorations
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
  be preserved. → src/features/editor/heightMapWarm.ts, docs/learnings/hr-scroll-jank.md
- Wikilinks `[[Title]]`.

## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. → markdown-spec/cases/09-tags, 13-adversarial
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized and hidden when the cursor is away.

## Tag bar _(desktop)_

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
  path, **closes the `]]`, and drops the caret AFTER the link** (`[[Title]]|`)
  so typing continues past the link, not inside it (a bare change dispatch left
  the caret stranded after `[[`). Works on Tauri and both native shells (same
  embed; verified on emulator + simulator 2026-06-09; caret-after-`]]` verified
  emulator + simulator 2026-07-08). → wikilinkAutocomplete.ts `makeApply`
- A wikilink whose target does not resolve is still decorated, styled **broken**
  (`cm-md-link cm-md-wikilink cm-md-wikilink-broken`) — not undecorated, and
  **visually distinct from a resolved link** (muted/dimmed styling so a dead
  link is identifiable before you tap it). The
  resolver (`resolveWikilink`) treats an **ambiguous** target (a bare filename
  matching more than one note) exactly like an absent one: both return `null` and
  render broken. Tapping a broken wikilink opens an empty editor bound to the
  wikilink's target text as the title; the note file is **created on the first
  edit/save**, not eagerly at navigation time — a **deferred** create-on-missing
  path (2026-07-11 decision). The earlier "eager" wording was already false on
  shipped desktop: `read_note` returns `""` for a missing file (never throws), so
  the create-on-missing catch in `loadNote` was dead and the empty note simply
  opened via the normal read path; the file appeared only once the user edited.
  → liveMarkdownTransform.ts, wikilinks.ts `resolveWikilink`,
  createNoteLoader.ts, editor-embed/main.ts
  > **Gap:** the **native** shells (iOS/Android) no-op a broken wikilink tap —
  > the editor embed posts `openNote` only for a _resolved_ link, so a broken
  > tap neither opens nor (on first edit) creates the target note the way
  > desktop does. _(native shells)_ → editor-embed/main.ts
- On the native shells, tapping a resolved wikilink navigates: the embed
  resolves the raw target against the pushed note list and posts `openNote`
  to the host, which **PUSHES a new editor onto the nav stack** — so **Back
  returns to the note you came from, not straight to the list** (a browser-like
  history of visited notes). A broken link posts nothing; a self-link (a
  wikilink to the note you are already on) is a no-op. Taps navigate via a
  dedicated `touchend` path — WebKit cancels the synthetic `click` after the
  handler's prevented `mousedown`, so a click-only handler dead-ends on iOS
  while Chromium double-fires; the touchend path covers both. A tap on a
  navigable link follows it on the **first** tap even when the editor is
  unfocused: on iOS the tap-to-focus handler (`iosTapFocus`) yields taps that
  land on a resolved wikilink or external link so the link handler acts on them,
  instead of consuming the tap to place the caret (a _broken_ wikilink still
  focuses, so it can be edited). Android has no such interceptor, so it already
  follows on the first tap (verified emulator 2026-07-08). Each pushed iOS
  editor needs an explicit `.id(noteId)` identity or SwiftUI would share one
  view's @State across the chain. Because the editor WebView is a single shared
  instance, iOS re-adopts it into whichever editor is visible on push/Back
  (`EditorContainerView.onEnterWindow`), and off-screen editors never drive it;
  Android composes only the top of the stack, so one note binds the WebView at
  a time by construction. Verified emulator + simulator 2026-07-08 (A → wikilink
  → B → Back returns to A with A's content intact and the editor still
  interactive; Back again returns to the list). → MarkdownEditor.svelte
  `wikilinkClickHandler`, MainActivity.kt `onOpenNote` (push),
  NoteEditorView.swift `openLinkedNote` + EditorWebView.swift `Coordinator.adopt`,
  tests/editor-embed-bridge.spec.ts
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
  native shells call the single `NoteStore.rename` or `NoteStore.moveNote`
  workflow, which moves the note and rewrites backlinks vault-wide under the
  store's workflow lock (verified on emulator + simulator 2026-06-09:
  bare-leaf and full-path links in other notes rewrote on disk).
  `[[target|alias]]` links are not rewritten — the TS rules treat the whole
  inner text as the target, and the Rust port pins that behavior. →
  futo-notes-model wikilinks.rs, futo-notes-store `LocalNoteStore::rename`,
  futo-notes-ffi `NoteStore::{rename,move_note}`

## External links

- Tapping/clicking an external link (`http(s)://`, autolinks, bare URLs) opens
  it in the system browser, never inside the editor. On the native shells a tap
  is detected via a dedicated `touchend` path in `linkClickHandler` (mirroring
  wikilinks — a click-only handler dead-ends on iOS WebKit) and the resolved URL
  is posted to the host via the `openUrl` bridge message (bridge v6); the host
  opens it in the system browser (iOS `UIApplication.open`, Android
  `ACTION_VIEW`), scheme-guarded to `http/https/mailto/tel`. `window.open` is a
  no-op inside a WKWebView, which is why the bridge round-trip is required.
  Android additionally enforces in `EditorWebView.kt` that only `file://` editor
  assets may load in the reused WebView; all other schemes are intercepted and
  launched with `ACTION_VIEW`. Verified emulator + simulator 2026-07-08 (tapping
  a rendered link opens Safari / Chrome to the target; iOS `openUrl` case and
  Android `ACTION_VIEW` intent both fire).
  → openUrl.ts, MarkdownEditor.svelte `linkClickHandler` (`onopenurl`),
  editor-embed/main.ts, packages/editor bridge v6 `openUrl`,
  EditorWebView.swift `openUrl` case, EditorWebView.kt `openExternalUrl` /
  `shouldOverrideUrlLoading` / `isInAppEditorNavigation`,
  tests/editor-embed-bridge.spec.ts
  > **Gap:** iOS native still lacks an explicit `WKWebView` navigation-policy
  > guard (the `openUrl` bridge covers taps on decorated links, but a
  > programmatic top-level navigation inside the WebView is not yet policed).

## Interactive elements

- Tapping a task checkbox toggles `[ ]`/`[x]` in the source and autosaves —
  no cursor placement needed.
- Table cells are individually editable in place; Tab/Shift+Tab move between
  cells; Enter inserts a new row below the current one (so on the last row it
  appends); structure is revalidated on each edit. A cell context menu (desktop right-click) inserts/deletes rows/columns.
  → table/interactiveTableEditor.ts, table/tableEditorWidget.ts,
  table/tableOperations.ts
- Pressing Enter in a list item continues the list (inherits nesting, auto
  numbers ordered items, renumbers on edit); Backspace at item start dedents;
  Backspace in an empty item deletes it. → listContinuation.ts
- Selecting text (desktop, single-line) raises a floating toolbar: Bold,
  Italic, Strikethrough, Code, Link. It hides for empty/multi-line selections
  and inside tables/code. → editorUX/selectionToolbar.ts _(desktop)_
- Typing `/` at the start of an empty block opens a block-command menu
  (headings, lists, tasks, quote, code, table, HR). Arrow keys move the
  highlight; a menu item activates on BOTH mouse click and Enter — the item
  must commit on the press (`mousedown`), because WebKit cancels the `click`
  that follows the menu's focus-guard `preventDefault`ed mousedown (same
  dead-end as the wikilink `touchend` note above). → editorUX/slashMenu.ts
  _(desktop)_

## Markdown toolbar _(native shells / editor-embed fallback)_

The shipping toolbar surface belongs to the native shells. The Tauri desktop
shell never switches to a mobile layout or renders a mobile toolbar based on
viewport width. The standalone editor embed retains a web toolbar as a bridge
fallback, but iOS and Android call `setNativeToolbar(true)` and render native
toolbar chrome instead. → src/editor-embed/EmbedToolbar.svelte,
EditorWebView.swift, EditorWebView.kt

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Bold, Italic, Strikethrough, Link, Heading, Quote, Bullet/Ordered/Task
  list, Indent/Outdent (shown when the cursor is on a list line), Camera,
  Image — horizontally scrollable, with a collapse chevron that blurs the
  editor (dropping both the keyboard and the toolbar). Link wraps the selection
  as `[selected](url)` (or inserts an empty `[]()` scaffold) with the caret in
  the URL slot — it does NOT prompt, since `window.prompt` is a no-op in the
  native WebViews. Verified emulator + simulator 2026-07-08 (Link sits after
  Strikethrough; no-selection inserts `[]()`, a selection wraps to `[sel]()`
  with the caret in the URL slot; no dialog appears). → EmbedToolbar.svelte,
  markdownToolbar.ts `TOOLBAR_EXEC` `link`, editorUX/linkCommand.ts `toggleLink`,
  tests/editor-embed-bridge.spec.ts
- The toolbar SURFACE — items, order, grouping, accessibility labels,
  per-platform icons, visibility rules — is defined once in the
  `@futo-notes/editor` manifest, and the editing BEHAVIOR behind every
  button is defined once in markdownToolbar.ts (`TOOLBAR_EXEC`). Toolbars
  are dumb dispatchers: no platform restates the item list or reimplements
  a command. → packages/editor/src/toolbar.ts, src/features/editor/markdownToolbar.ts,
  tests/editor-embed-bridge.spec.ts
- Native shells, toolbar chrome is NATIVE, commands are shared (bridge v3):
  the host renders its own toolbar from a GENERATED copy of the manifest and
  drives the editor over the bridge — `exec(id)` runs the shared command,
  the `cursorContext` message drives Indent/Outdent visibility, `blur()`
  backs the dismiss chevron, and `setNativeToolbar(true)` suppresses the
  embed's web toolbar so two never show. `just toolbar-spec` regenerates the
  native specs; `just toolbar-spec-check` (part of `just check`) fails when
  one drifts from the manifest. → packages/editor/src/bridge.ts,
  scripts/gen-toolbar-spec.ts, tests/editor-embed-bridge.spec.ts
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
- Android native: dismissing the soft keyboard by the system back
  gesture/button (not just the chevron) also blurs the editor — the caret
  and selection handle must not linger on screen with no keyboard (#24).
  The app-root `ClearFocusOnImeDismiss` ([app.md](app.md) "Soft keyboard")
  drops native-field focus, and its root install also blurs the editor over
  the bridge on the same IME visible→hidden transition — the editor's DOM
  caret survives a view-level clearFocus. (iOS can't hit this: keyboard and
  first-responder caret are coupled.) → MainActivity.kt,
  ui/components/ImeDismiss.kt, EditorImeDismissBlurTest.kt
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
  `@futo-notes/editor` `IMAGE_EXTENSIONS`, conformance-locked to the canonical
  Rust vault rule. Native Swift/Kotlin pickers receive that Rust list through
  generated UniFFI bindings. Both clipboard shapes work: a raw
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
  `pasteFromNativeClipboard`;
  `apps/tauri/src-tauri/src/image_commands.rs` `fs_paste_clipboard_image`
- Images render inline in live preview via the Tauri asset protocol, with a
  `readFile`→blob-URL fallback when the asset protocol can't actually decode an
  `<img>` (macOS WKWebView / Linux WebKitGTK answer the request but paint a
  blank white box; the gate is a real image-decode probe, not a HEAD probe).
  → `src/lib/platform/tauri/images.ts` `getImageUrl` / `canDecodeImageUrl`.
  _(Tauri)_
- The native shells render local images inline through a host-registered
  image base URL (`setImageBaseUrl`): iOS serves the vault root through a
  `futo-asset://` WKURLSchemeHandler (path-traversal- and image-extension-
  guarded); Android serves `file://<vault root>/` directly. Insert path is
  the toolbar Camera/Image flow above; picked images save into the vault and
  render inline (verified end-to-end on emulator + simulator 2026-06-09).
  → EditorImages.swift `FutoAssetSchemeHandler`, ImagePicker.kt,
  live-preview/images.ts `setLocalImageBaseUrl`, tests/editor-embed-bridge.spec.ts
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
  fs_paste_clipboard_image (Tauri), tests/editor-embed-bridge.spec.ts

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

## Saving & rename _(native shells)_

- Body edits autosave on a debounce (~400 ms). The save re-reads the current
  note id at fire time, so a save landing **after** a rename writes to the
  renamed note, not a stale id. → NoteEditorScreen.kt / NoteEditorView.swift
  `scheduleSave`
- Title edits debounce (~500 ms) into a rename (iOS commits via the rename
  dialog instead). Before the file moves, any pending body save is flushed to
  the _current_ id and the in-flight save is cancelled — otherwise a stale save
  recreates a ghost note at the old id (data loss). → NoteEditorScreen.kt /
  NoteEditorView.swift `commitRename`
- Leaving the editor flushes a pending save only if the content changed. The
  engine then decides whether the note is written, recreated, or parked.
- Backgrounding the app makes a **best-effort** flush of the open editor's
  pending edit at the first leave-foreground signal, so an edit caught inside the
  autosave debounce is usually persisted before the OS jetsams the process. The
  flush is fire-and-forget, so an immediate process death can still beat the
  write — true on both native shells. → Android MainActivity `onPause` →
  `NotesStore.flushPendingEditor`; iOS FutoNotesApp scenePhase
  `.inactive`/`.background` → `NotesStore.flushPendingEditor`
- A leave/background flush goes through the engine's ONE draft-saving verb
  (persist-or-park, ADR-0001): `flush_draft(id, base, content)` resolves every
  surprise itself under the engine's per-workflow serialization and returns one
  flush disposition plus the mutation to apply — **wrote** (the note still held
  `base`; content a live pull adopted since the editor's last read is never
  clobbered by a stale flush), **converged** (disk already equals the draft —
  explicit, no rewrite, no mtime bump; shells never read disk to compare),
  **recreated** (peer deleted; the edit wins at the ORIGINAL id — the same home
  the editor's resume autosave rewrites, so survive + jetsam converge with no
  duplicate copy; the install is atomic no-replace, so a live-sync write that
  recreates the id outside the engine's serialization in the flush window is
  not clobbered — the draft is parked instead), or **parked** as a conflict
  copy (peer changed; both versions survive, the copy id reported). A dirty
  draft is never silently dropped; a clean editor never flushes, so a genuinely
  abandoned note is never resurrected. Conflict copies are named by the
  engine's one conflict-naming rule ("<title> (conflict YYYY-MM-DD)", counter
  suffix on a same-day collision), and parking is idempotent — a crash-window
  double-park mints ONE copy. _(iOS; Android/desktop adopt in #38 — Android's
  flush still drops on skip, desktop saves unconditionally.)_ →
  `futo_notes_store::LocalNoteStore::flush_draft` via FFI `flush_draft`;
  `NotesStore.flushDraft`/`flushAsync`; conflict naming
  `futo_notes_core::conflict_names`. Guarded by the flush_draft unit tests in
  crates/futo-notes-store/src/tests.rs (all four dispositions, converged/park
  boundary, recreate-vs-reappeared window, park idempotency, recreate-arm
  mutation positioning), the FFI note_contract test, and
  apps/ios/Tests/FlushDraftVerbTests.swift. Earlier behavior verified on iOS
  2026-07-13 (sim); verb wiring verified via `just test-ios-native`
  2026-07-21.
- The open editor's unsaved-draft register is **derived** from the editor's live
  state (note id, buffer, saved content, loaded) rather than hand-synced, so it
  goes clean the instant a save completes or a remote is adopted (no stale draft
  clobbers the adopted content). It is owner-scoped so a screen leaving during a
  push/pop transition can't drop the incoming screen's draft. Android registers
  one derivation closure the flush pulls synchronously; iOS publishes the derived
  value both synchronously in the WebView change callback (so the register is
  current the instant before a background flush reads it) and reactively via
  `.onChange` for the clear-on-save / clear-on-adopt transitions — SwiftUI
  `@State` can't be pulled from an escaping closure the way Compose snapshot state
  can. _(iOS, Android)_ → NoteEditorScreen.kt / NoteEditorView.swift →
  `NotesStore.setDraftProvider`/`publishDraft` + `claimDraftOwnership`. Verified
  on iOS 2026-07-13 (sim: edit → immediate background before the debounce
  persisted; rename with a pending body edit preserved the edit under the new id
  with no ghost). NOTE: a simulator can't reproduce OS jetsam, so this validates
  the surviving-process flush path, not an actual jetsam-during-background kill.
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

- Backspace on an empty note must not crash the WebView renderer. _(Android)_
  - _History (resolved):_ Chromium 147's empty-editable surrounding-text path
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
