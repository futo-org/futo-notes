## List

- Shows the notes whose parent folder is exactly the folder being browsed
  (see [Folder browsing](folder-browsing.md#folder-browsing)); on Tauri, the notes of the folder
  selected in the sidebar tree. → NoteListScreen.kt _(Android)_,
  NoteListView.swift _(iOS)_
- Notes are sorted by the engine's active **sort order**: a key (**Last
  Modified** or **Name**) and a direction, with id ascending on a tie. The
  default is Last Modified newest first; every shell can change it (see the
  sort-control lines below). Name compares the title (the filename)
  case-insensitively. The sort rule lives **only in the Rust engine**
  (ADR-0001): snapshots arrive sorted,
  and every committed mutation carries each affected note's **final id** and
  its **position** in the sorted list (positions defined after removals),
  together with the post-commit folder projection. All three shells apply that
  result directly—no shell-side sort, identity rule, or follow-up folder scan.
  Positions are clamped so a stale value cannot crash. **Opening a note does
  not count as modifying it** — under Last Modified only an actual content or
  title change moves a note to the top; under Name only a title change moves
  it. → futo-notes-store `vault::note_list_order` / `finish_mutation` /
  `set_sort_order`; notes.svelte.ts `_applyLocalMutation`, NotesStore.swift /
  NotesStore.kt `applyMutation`
- A write sets the note's modified time itself rather than inheriting whatever
  the filesystem left on the installed file, so the time the engine reports is
  the time the note has on disk. Samsung f2fs/FUSE devices were observed
  leaving a note's old mtime in place after an atomic install: content landed,
  the list showed the fresh time the engine reported, and a relaunch read the
  stale one back, freezing Last Modified order. One owner sets it, so every
  write site agrees on which times move: a create, an edit and a **title
  change** all take `now`, an explicitly supplied time (a sync peer's
  `updated_at`) is honored exactly, and two writes that are not changes to the
  note keep its existing time: **moving** it between folders (its title is
  untouched — only its parent moved) and having its **backlinks** rewritten by
  someone else's rename. Neither may move it to the top, on any filesystem.
  → futo-notes-store `stamp_note`, called from `write_raw` / `install_new` /
  `rename_raw` / `finish_mappings`
- Every note id appears in the list exactly once, because every list keys its
  rows by id. A file is a note only when its id names that exact file: a Unix
  filename holding `\` or a filename that is not UTF-8 is not a note, since it
  would alias another note's id. A directory read that returns a name twice
  still yields one note. Folders are named the same way: a Unix folder named
  `x\y` is not listed, and never becomes the folders `x` and `x/y`. →
  futo-notes-core `files::vault_fs::relative_name`; futo-notes-store
  `vault::note_id_of` / `walk`
- _(Tauri)_ A **sort button** right of the sidebar search bar (notes view only)
  opens the same anchored dropdown the note ⋮ menu uses, in two labelled
  sections: **Sort by** (**Name** / **Last Modified**) and **Order** (the
  direction pair for the active key — **A-Z** / **Z-A** for Name, **Recent
  first** / **Oldest first** for Last Modified), with the active choices
  checked. Picking a key keeps the menu position: Recent first ↔ A-Z, Oldest
  first ↔ Z-A.
  Unlike the note ⋮ menu, picking keeps the menu open; it closes on a click
  outside or Escape. One engine call sets the order and returns the vault in
  it, which replaces the list; the choice persists per device (localStorage
  `futo-notes:noteSortOrder`) and is handed to the engine with the startup
  listing, so the first frame is already in the persisted order.
  → SidebarSortControl.svelte, noteSortOrder.ts, local_notes.rs
  `local_notes_startup_listing` / `local_notes_set_sort_order`
- _(iOS)_ In **compact width on iOS 26** a **sort button** is a separate
  bottom-toolbar item immediately left of the system search field
  (`ToolbarSpacer(.fixed)` between them), so it gets the same glass circle,
  size, gap and show/hide animation as the system Cancel button; the search
  field itself is untouched and the system hides the sort button while a search
  is active. On iOS 18 it is a top-trailing item beside compose. The button is
  a system `Menu` whose label is the custom **SortDescending symbol set** in a
  36pt square frame: the toolbar hit-tests only the label's frame, so a bare
  glyph leaves the outer ring of the 48pt glass circle dead, while a wider
  frame turns the circle into a pill. The menu holds two titled
  `Section`s — **Sort by** (**Name** / **Last Modified**) and **Order** (the
  direction pair for the active key) — of menu toggles, so checked state, tap
  targets, glass and animation are the system's; iOS drops images from section
  headers, so the headers are text only. `menuOrder(.fixed)` keeps **Sort by**
  on top even though the menu opens upward from the bottom bar. Picks use
  `menuActionDismissBehavior(.disabled)` so the menu KEEPS open like desktop
  and Android; it dismisses on an outside tap. Picking a key keeps the menu
  position (Recent first ↔ A-Z). One engine call sets the order and returns the vault
  in it; the store publishes and persists only after the engine confirms
  (UserDefaults `futo.noteSortOrder`, `"<key>:<direction>"`) and hands the
  order to the engine with `bootstrap`, so the first frame is already in the
  persisted order.
  → NoteListView.swift, NoteSortPreference.swift, futo-notes-ffi
  `NoteStore::bootstrap` / `NoteStore::set_sort_order`
- _(Android)_ A **sort button** sits immediately left of the top-bar Search
  action (the actions read new folder, sort, search, settings). It opens an M3
  dropdown with the same two labelled sections and a trailing check mark on each
  active choice. Every Android popup menu wears the product's surface (12.dp
  radius, paper fill, hairline border), not Material3's square tonal default.
  → ui/components/FutoMenu.kt. Picking KEEPS the menu
  open — it dismisses on an outside tap or Back — so key and direction are one
  visit. The choice persists per device (SharedPreferences `sort_order`,
  `"<KEY>:<DIRECTION>"`) and is handed to the engine with `bootstrap`, so the
  first frame is already in the persisted order.
  → ui/components/NoteSortMenu.kt, NoteListScreen.kt, NoteSortPreference.kt,
  MainActivity.kt `initVault`
- On the native shells the editor is a full-screen push (the list isn't
  visible while editing), so the splice that re-ranks an edited row happens
  while the list is off-screen; the list re-appears already in engine order —
  there is no on-appear resort. Android's return-to-list still re-pins an
  at-top viewport to index 0 (`isAtListTop` + `requestScrollToItem` in
  `AppNavigator.goBack`) because LazyListState anchors to the previously-first
  row's key. Desktop Tauri reorders live. → AppNavigation.kt
  `AppNavigator.goBack`,
  NoteListScreen.kt `isAtListTop`
  > **Gap:** _(Android)_ A **sync live pull** that creates or re-ranks a note
  > while the list is composed at the top still relies on LazyListState key
  > anchoring, so the remotely-changed row can land above the viewport until
  > the user drags. Same anchoring class as the local-edit invisibility bug
  > fixed 2026-07-02 (local create/edit now re-pin via `requestScrollToItem`
  > on the FAB path and a pop-time re-pin in `AppNavigator.goBack()`); the
  > sync live-pull path (`SyncManager` `LiveListener.onSynced` →
  > `onLocalTreeChanged` → NotesStore.kt `applyLocalTreeChange`) has no at-top
  > re-pin yet. → NotesStore.kt `applyLocalTreeChange`, AppNavigation.kt
  > `AppNavigator.goBack`
- Tapping a note opens it in the editor (no autofocus). → NoteListScreen.kt /
  AppNavigation.kt
- The list keeps the folder it is browsing and that folder's scroll position
  through a note, Search, or Settings. Returning restores both; after the initial
  vault load, a folder that no longer exists pops to the nearest surviving
  ancestor (see [Folder browsing](folder-browsing.md#folder-browsing)). → NoteListState.kt /
  NoteListStateTest.kt / AppNavigationTest.kt _(Android)_; NoteListView.swift
  _(iOS)_
- An empty folder shows an empty state, and **both native shells distinguish the
  case**: "No notes yet" at the vault root, "Empty folder" inside a folder, both
  subtitled "Tap + to add a note." on Android and "Tap the compose button to add
  a note." on iOS. _(Tauri: "Nothing here yet".)_ The
  empty state waits for the first scan (`hasBootstrapped`) so a cold start never
  flashes it (M1). → NoteListView.swift, NoteListScreen.kt `EmptyState`
- The top bar carries the page surface, and gains a bottom hairline once the
  list is scrolled. _(Android)_ → NoteListScreen.kt
- Each note row shows a **rich, multi-line** body preview rather than raw
  markdown: line breaks are preserved (up to 3 lines), heading/quote markers are
  stripped, task items render as ☐/☑, bullets as •, tables and rules are
  dropped entirely, code-fence **delimiters** are dropped while the fenced text
  itself is kept as plain preview lines, and inline `**bold**` / `*italic*` /
  `` `code` `` / `~~strike~~` render as real styling. The block-markdown rewrite is the shared Rust rule
  `make_rich_preview` (futo-notes-model), exposed over FFI and carried on
  `NoteMetadata.richPreview`. _(iOS native)_ renders it via `AttributedString`
  (`.inlineOnlyPreservingWhitespace`) → NoteListView.swift `NoteRow`; _(Android
  native)_ via a small inline-markdown `AnnotatedString` parser → NoteCard.kt /
  InlineMarkdown.kt.
  > **Gap:** Tauri desktop sidebar note rows show the **title only** — no body
  > preview at all. The single-line, markdown-opaque `make_preview` snippet
  > appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar
  > rows. The rich multi-line preview is native-only (iOS + Android) for now.
- An embedded image stands in as a single 🖼️ in **every** preview — the
  rich multi-line one and the single-line `make_preview` snippet alike — never
  as raw `![alt](target)` markdown and never dropped. Surrounding text is kept,
  so `![](image-20260814-130425.png)` above a line of prose previews as
  "🖼️ Meeting notes". A construct missing its `]` or `)` is not an image
  and stays verbatim, and a plain `[link](url)` is untouched. The rule is shared
  Rust (`futo_notes_model::IMAGE_PLACEHOLDER`, applied inside `make_preview` and
  `make_rich_preview`), mirrored per-keystroke by `packages/editor/src/preview.ts`
  and pinned bit-for-bit by tests/conformance/preview.json.
  → crates/futo-notes-model/src/note.rs / packages/editor/src/preview.ts
- A `<br>` tag reads as a single space in **every** preview, never as literal
  `<br />` text, and a line that is nothing but the tag contributes no preview
  line at all. Both kinds of `<br>` in a vault are covered: the one the WYSIWYG
  editor writes for a blank line the author typed (markdown cannot represent an
  empty paragraph, so `@milkdown/preset-commonmark`'s serializer parks a
  placeholder in the file) and the one an author writes to break a line inside a
  GFM table cell. Other inline HTML is deliberately left verbatim — `<kbd>K</kbd>`
  previews as itself — because a rule that removes anything between angle
  brackets also removes `a <b` in prose. Shared Rust
  (`replace_line_break_tags`, applied inside `make_preview` and
  `make_rich_preview`), mirrored per-keystroke by `packages/editor/src/preview.ts`
  and pinned bit-for-bit by tests/conformance/preview.json.
  → crates/futo-notes-model/src/note.rs / packages/editor/src/preview.ts
- Preview text is never interactive: tapping anywhere on a note row — including
  preview text that looks like a URL — always opens the note, never a link.
  _(iOS native)_ `AttributedString(markdown:)` auto-attaches a `.link`
  attribute to URL-shaped preview text; `NoteRow.stripLinkAttributes` removes
  it from every run before render so the row's `NavigationLink` always gets
  the tap. → NoteListView.swift `NoteRow`
