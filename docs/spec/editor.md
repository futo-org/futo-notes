# Editor — Spec

The editor is a shared CodeMirror 6 WebView — the **same `editor.html` /
`packages/editor` bytes on all platforms**. It renders Obsidian-style live
preview. Fine-grained decoration/cursor cases live in `markdown-spec/cases/`;
this file states the behaviors a human cares about.

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
- Tables (GFM), horizontal rules, and images — rendered as block widgets.
- Wikilinks `[[Title]]`.

## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. → markdown-spec/cases/09-tags, 13-adversarial
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized and hidden when the cursor is away.

## Tag bar *(Tauri)*

- A tag bar sits between the title and the editor: one chip per current tag,
  plus a "+ Tag" affordance. → NoteTagBar.svelte
- "+ Tag" opens an inline input with autocomplete over the vault's existing
  tags (case-insensitive); a non-matching entry shows a "Create #name" option.
  Enter or comma commits; verified on Android Tauri 2026-06-09.
- Committing a tag writes it into the note's **leading header tag block**
  (creating the block when absent) — the tag is note content, not metadata.
- Removing a chip removes the tag; removing the last tag removes the entire
  header block.
  > **Gap:** the native shells have no tag bar — tags can only be edited as
  > text in the body. → NoteEditorScreen.kt / NoteEditorView.swift

## Wikilinks — navigation & integrity

- Clicking/tapping a wikilink navigates to the target note (desktop:
  Cmd/Ctrl+click opens it in a new tab). Verified on Android Tauri 2026-06-09.
  → NotesShell.svelte onopenlink
- A wikilink displays the **shortest unique path suffix** (`[[Projects/Roadmap]]`
  renders as "Roadmap" while unambiguous). → wikilinks.ts
  > **Gap:** the native shells show the full path — the suffix resolver needs
  > the vault note list, which only the Tauri shell feeds to the editor
  > (observed Android native 2026-06-09).
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path. → wikilinkAutocomplete.ts *(Tauri)*
- A broken or ambiguous wikilink renders undecorated (not a live link).
- **Renaming or moving a note rewrites every wikilink that points at it,
  across all notes** — including folder moves (`[[Markdown demo]]` →
  `[[Archive/Markdown demo]]`). Verified end-to-end on Android Tauri
  2026-06-09. → wikilinks.ts rewrite rules, notes.svelte.ts
  `rewriteWikilinksForRename`
  > **Gap:** the native shells render wikilinks but do not navigate on tap
  > (the tap just places the cursor; verified Android native 2026-06-09),
  > have no autocomplete, and do not relink on rename/move — the relink logic
  > lives in TS (`rewriteWikilinksForRename`), not in the shared Rust crates,
  > so a rename on a native device silently breaks backlinks vault-wide.

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

## Markdown toolbar *(Tauri mobile)*

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Bold, Italic, Strikethrough, Heading, Quote, Bullet/Ordered/Task
  list, Indent/Dedent, Camera, Image — horizontally scrollable, with a
  collapse chevron. It hides when the editor blurs. Verified on Android Tauri
  2026-06-09. → MarkdownToolbar.svelte
- Camera inserts a photo from the device camera or photo library; Image opens
  a file picker. Both save the image into the vault and insert `![](file)`.
  > **Gap:** the native shells have no markdown toolbar — formatting is
  > typed by hand.

## Images *(Tauri)*

- Pasting an image into the editor (desktop) saves it to the notes directory
  and inserts `![](filename)`; supported types follow
  `@futo-notes/shared` `IMAGE_EXTENSIONS`. → imagePaste.ts
- Images render inline in live preview via the Tauri asset protocol.
  > **Gap:** the native shells do not render local images in the editor
  > WebView and have no insert/paste path.

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
