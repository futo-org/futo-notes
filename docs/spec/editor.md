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
- Wikilinks `[[Title]]`.

## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. → markdown-spec/cases/09-tags, 13-adversarial
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized and hidden when the cursor is away.

## Tag bar *(desktop)*

The tag bar is a **desktop-only surface by decision (2026-06-09)** — mobile
(native shells; the legacy Tauri mobile shell still happens to render it)
edits tags as text in the body, which is not a gap.

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
  Cmd/Ctrl+click opens it in a new tab). Verified on Android Tauri 2026-06-09.
  → NotesShell.svelte onopenlink
- A wikilink displays the **shortest unique path suffix** (`[[Projects/Roadmap]]`
  renders as "Roadmap" while unambiguous). The native shells feed the vault
  note list into the shared editor WebView over the bridge (`setNotes`), so
  the same resolver runs there (verified Android native + iOS simulator
  2026-06-09). → wikilinks.ts, packages/editor bridge v2,
  EditorWebView.kt / EditorWebView.swift
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path. Works on Tauri and both native shells (same embed; verified on
  emulator + simulator 2026-06-09). → wikilinkAutocomplete.ts
- A broken or ambiguous wikilink renders undecorated (not a live link).
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
  `[[Archive/Markdown demo]]`). Verified end-to-end on Android Tauri
  2026-06-09. → wikilinks.ts rewrite rules, notes.svelte.ts
  `rewriteWikilinksForRename`
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
  no cursor placement needed. Verified on Android Tauri 2026-06-09.
- Table cells are individually editable in place; Tab/Shift+Tab move between
  cells; Enter on the last row appends a row; structure is revalidated on each
  edit. A cell context menu (desktop right-click) inserts/deletes rows/columns.
  → tableEditor.ts
- Pressing Enter in a list item continues the list (inherits nesting, auto
  numbers ordered items, renumbers on edit); Backspace at item start dedents;
  Backspace in an empty item deletes it. → listContinuation.ts
- Selecting text (desktop, single-line) raises a floating toolbar: Bold,
  Italic, Strikethrough, Code, Link. It hides for empty/multi-line selections
  and inside tables/code. → editorUX/selectionToolbar.ts *(desktop)*
- Typing `/` at the start of an empty block opens a block-command menu
  (headings, lists, tasks, quote, code, table, HR); a `+` block handle in the
  margin opens the same menu. → editorUX/slashMenu.ts *(desktop)*

## Markdown toolbar *(Tauri mobile + native shells)*

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Bold, Italic, Strikethrough, Heading, Quote, Bullet/Ordered/Task
  list, Indent/Outdent (shown when the cursor is on a list line), Camera,
  Image — horizontally scrollable, with a collapse chevron that blurs the
  editor (dropping both the keyboard and the toolbar). Verified on Android
  Tauri 2026-06-09. → MarkdownToolbar.svelte
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
  `@futo-notes/shared` `IMAGE_EXTENSIONS`. → imagePaste.ts
- Images render inline in live preview via the Tauri asset protocol. *(Tauri)*
- The native shells render local images inline through a host-registered
  image base URL (`setImageBaseUrl`): iOS serves the vault root through a
  `futo-asset://` WKURLSchemeHandler (path-traversal- and image-extension-
  guarded); Android serves `file://<vault root>/` directly. Insert path is
  the toolbar Camera/Image flow above; picked images save into the vault and
  render inline (verified end-to-end on emulator + simulator 2026-06-09).
  → EditorImages.swift `FutoAssetSchemeHandler`, ImagePicker.kt,
  liveMarkdownTransform.ts `setLocalImageBaseUrl`

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
  Tauri 2026-06-09.

## Android — IME

- Backspace on an empty note must not crash the WebView renderer. *(Android)*
  - *History (resolved):* Chromium 147's empty-editable surrounding-text path
    tripped a `CHECK()` (`SIGTRAP`) when FUTO Keyboard queried it on backspace.
    This was **fixed upstream by a FUTO Keyboard update**, so the in-app IME
    shield is no longer required. → docs/learnings/ime-shield-workaround.md
  - The IME-shield workaround still exists in the **Tauri** Android build
    (guarded by `just verify-ime-shield`) but is now dead weight — it can be
    removed in a separate cleanup. The native Compose app never carried it and
    is fine without it.
