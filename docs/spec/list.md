# Note List — Spec

The home screen: notes in the current folder, a folder drawer, and search /
new-note affordances.

## Home ("For You") *(Tauri)*

- With no note open, the main pane shows a "For You" feed of recent-note cards
  (title, preview, relative modified time); tapping a card opens the note.
  Cards reorder as notes are edited. → ForYouPage.svelte
- An empty vault shows a **"FUTO Notes"** heading. On mobile the subtitle reads
  "Create your first note to get started." with a **"Browse notes"** button
  (opens the drawer) and a **"Quick capture"** button below the feed area; on
  desktop only the subtitle "Create your first note from the sidebar to get
  started." shows (both buttons are mobile-only). → ForYouPage.svelte
- Quick capture creates a new note and opens it ready to type. Backing out of
  an untouched quick-capture note leaves no note behind. Verified on Android
  Tauri 2026-06-09.

## List

- Shows the notes in the current folder, or all notes when "All notes" is
  selected. → NoteListScreen.kt
- Notes are sorted most-recently-modified first. **Opening a note does not count
  as modifying it** — only an actual content or title change moves a note to the
  top.
- On the native shells the editor is a full-screen push (the list isn't visible
  while editing), so a content/title edit refreshes the row **in place** while
  typing — stable identity/order, no editor-popping, the deliberate
  `NotesStore.write` optimization — and the list resorts
  most-recently-modified-first when it re-appears on editor close, never on a
  keystroke. The resort is a cheap in-memory sort (`NotesStore.resortInPlace()`,
  key `modified` desc then `id`, matching the Rust scan order) fired from
  `FolderContentsView.onAppear` on iOS and a `LaunchedEffect` in `NoteListScreen`
  on Android. Desktop Tauri resorts live. → NotesStore.swift / NotesStore.kt
  `resortInPlace`
  > **Gap:** *(Android)* A **sync live pull** that creates or re-ranks a note
  > while the list is composed at the top still relies on LazyListState key
  > anchoring, so the remotely-changed row can land above the viewport until
  > the user drags. Same anchoring class as the local-edit invisibility bug
  > fixed 2026-07-02 (local create/edit now re-pin via `requestScrollToItem`
  > on the FAB path and a pop-time resort in `AppShell.pop()`); the
  > `reloadAsync` sync-pull path has no at-top re-pin yet. → NotesStore.kt
  > `reloadAsync`, MainActivity.kt `AppShell.pop`
- Tapping a note opens it in the editor (no autofocus). → NoteListScreen.kt /
  MainActivity.kt
- The list keeps its scroll position while you navigate: scroll, open a note
  (or Search / Settings), come back — the list is where you left it, not
  jumped to the top. → MainActivity.kt saved per-screen state *(Android
  native)*, NoteListView.swift NavigationStack *(iOS native)*
- An empty folder shows an empty state. *(Tauri/Android: "Nothing here yet".
  iOS native distinguishes the case: "No notes yet" at the vault root, "Empty
  folder" inside a folder — NoteListView.swift.)*
- The top bar is transparent at rest and gains a surface fill + bottom border
  once the list is scrolled. *(Android)*
- Each note row shows a **rich, multi-line** body preview rather than raw
  markdown: line breaks are preserved (up to 3 lines), heading/quote markers are
  stripped, task items render as ☐/☑, bullets as •, tables and rules are
  dropped entirely, code-fence **delimiters** are dropped while the fenced text
  itself is kept as plain preview lines, and inline `**bold**` / `*italic*` /
  `` `code` `` / `~~strike~~` render as real styling. The block-markdown rewrite is the shared Rust rule
  `make_rich_preview` (futo-notes-model), exposed over FFI and carried on
  `NoteMetadata.richPreview`. *(iOS native)* renders it via `AttributedString`
  (`.inlineOnlyPreservingWhitespace`) → NoteListView.swift `NoteRow`; *(Android
  native)* via a small inline-markdown `AnnotatedString` parser → NoteCard.kt /
  InlineMarkdown.kt.
  > **Gap:** Tauri desktop sidebar note rows show the **title only** — no body
  > preview at all. The single-line, markdown-opaque `make_preview` snippet
  > appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar
  > rows. The rich multi-line preview is native-only (iOS + Android) for now.

## Folder drawer

- Opened from the menu icon (or an edge swipe). Lists "All notes" first, then
  each folder path, each with a live note count. → NoteListScreen.kt *(Android
  native)*
- Selecting a folder filters the list and closes the drawer.
- A Settings entry sits at the bottom of the drawer.
- **Tauri** does not use this "All notes" + per-folder-count drawer. Its
  sidebar is a **tabbed folder tree** (files / tags / images — see [Sidebar
  tabs](#sidebar-tabs-tauri)): the files tab is a virtualized folder tree with
  no "All notes" row and no per-folder note counts. → DrawerSidebar.svelte /
  FolderTreeView.svelte

**iOS native, by design, has no drawer** (intentional platform difference, not a
gap): instead of the drawer / **"All notes"** entry / **live per-folder note
counts** — which are the **Android-native** surface above — it uses a
`NavigationStack` folder browser (the root shows folders-as-rows + root notes;
tapping a folder pushes its contents) and reaches Settings via a nav-bar **gear
icon**. `NotesStore.noteCount(under:)` exists but is only used for delete
confirmation, not surfaced as a per-folder count. → NoteListView.swift
`FolderContentsView`

## Sidebar drag & drop *(desktop)*

- Notes and folders can be dragged onto a folder (or the root) in the sidebar
  to move them. Internal drags carry custom MIME types
  (`application/futo-note-id`, `application/futo-folder-path`). →
  FolderTreeView.svelte / DrawerSidebar.svelte
- Both **Windows and macOS** builds set `dragDropEnabled: false`
  (`tauri.windows.conf.json` / `tauri.macos.conf.json`): wry's native
  drag-drop interception (WebView2 on Windows, WKWebView on macOS) otherwise
  swallows the sidebar's internal HTML5 `dragover`/`drop`, making drag & drop
  inert (the dragged row follows the cursor but no folder highlights and the
  drop never lands — macOS repro fixed 2026-07-08). With interception off, OS
  file drops reach the DOM — a window-level guard (`externalFileDropGuard.ts`)
  prevents them from navigating the webview, on every platform. Linux keeps
  `dragDropEnabled` on (WebKitGTK doesn't swallow internal drags).
- The custom drag-image ghost (a 1×1 canvas to suppress the OS image + a DOM
  mirror that follows the cursor) is **WebKitGTK-only** (`isLinux`). WebKitGTK
  needs it because it rasterizes the OS drag image blurry on hi-DPI; macOS
  WKWebView and Windows WebView2 render native drag images crisply. Critically,
  it must NOT run on WKWebView: mutating the DOM during `dragstart` aborts the
  drag there (dragstart → dragend, zero dragover) — a separate failure from the
  wry interception above; both had to be fixed for macOS drag & drop to work
  (2026-07-08). → FolderTreeView.svelte `setControlledDragImage`

## New note

- The FAB creates an "Untitled" note in the current folder (the vault root when
  "All notes" is selected) and opens it with the **body** focused for quick
  capture (keyboard on the note text, not the title). → NoteListScreen.kt
- On mobile-width shells, "+ New" opens the note with the **title** focused and
  "Untitled" select-all'd so typing replaces it immediately. Desktop keeps body
  focus; the wikilink-to-missing-note create path keeps body focus everywhere.
  → noteSession.svelte.ts `loadNote('new')`, NotesShell.svelte `focusTitle`

## Note actions (menu)

- An open note's overflow menu offers: **Graph view** (stub — toast
  "coming soon"), **Copy file path** (full filesystem path to clipboard),
  **Move to folder**, **Delete note**. → NotesShell.svelte note menu
- "Move to folder" opens a folder picker (root "Notes" + folder tree, nesting
  shown); picking a destination moves the file, keeps the note open under its
  new id, and rewrites backlinks. → FolderPickerModal.svelte
- "Delete note" asks for confirmation ("This action cannot be undone."), then
  deletes the file. *(Desktop)* routes through the OS trash — recoverable via
  the OS trash — falling back to permanent delete if the platform trash is
  unavailable (e.g. headless CI). *(iOS, Android)* delete permanently; there
  is no trash in the native UI flow. Sync is unaffected either way — the file
  leaving the vault tombstones the note on the next sync exactly as a
  permanent delete would. Deleting the only note in a folder prunes now-empty
  ancestor folders — **on every platform**: Tauri via
  `prune_empty_parent_dirs`, the native shells via the shared Rust
  `delete_note` (which prunes since 2026-07-02; it previously left empty
  parents behind, native-only). →
  fileSystem.ts `deleteNoteFileToTrash` → platform/tauri.ts
  `deleteNoteToTrash` → `notes_delete_to_trash`,
  `apps/tauri/src-tauri/src/note_commands.rs`, futo-notes-model
  `crud::delete_note`
- A note row in the folder tree offers the same Move/Delete via context menu
  (desktop right-click / mobile long-press). → FolderTreeView.svelte
- The native editor menus reach parity: **Android** ⋮ offers Move to
  folder… / Copy file path / Delete note (Share is a dedicated top-bar
  action); **iOS** ⋯ offers Rename / Move to Folder… / Copy File Path /
  Share / Delete Note. A move keeps the note open under its new id and
  relinks backlinks (`NoteStore.relink`). **Every destructive delete on the
  native shells asks for confirmation** ("Delete this note? This action
  cannot be undone.") — editor menus, list rows, swipe actions, and search
  results alike (verified on emulator + simulator 2026-06-09). →
  NoteEditorScreen.kt, NoteEditorView.swift, ConfirmDialog.kt
- **iOS native** note rows expose **Move to Folder…** and **Delete** via
  long-press context menu / swipe actions; the move sheet lists Root, every
  folder, and an inline "New Folder…" option, and the move is applied on
  disk immediately (verified 2026-06-09). → NoteListView.swift
- **Android native** note rows expose the same Move to Folder… / Delete via
  long-press; the move sheet matches iOS (Root, every folder, inline "New
  Folder…") and applies the move + backlink relink immediately, with a
  "Moved to {folder}" toast (verified on emulator 2026-06-09). →
  NoteListScreen.kt, FolderPickerSheet.kt
- **Both native shells create notes as quick capture** (iOS "+" menu → New
  Note; Android FAB → New note): an "Untitled" note is created in the current
  folder and the editor opens with the **body** focused — no blocking title
  prompt, keyboard straight on the note text (desktop parity). An **untouched**
  quick-capture note — opened brand-new, never renamed, body still empty — is
  **discarded on back-out** so nothing is left behind, matching desktop. →
  NoteListView.swift / NoteEditorView.swift `onDisappear`, NoteListScreen.kt /
  NoteEditorScreen.kt `onDispose`
- **Both native shells have an inline, tappable title field** above the editor
  body (iOS via a `UITextField`-backed `TitleTextField`, Android via a
  `BasicTextField`); tapping it edits the title in place and renames the file,
  debounced (500 ms). Tapping a title that is still the auto-assigned
  placeholder — "Untitled" or a dedup "Untitled-N" — **selects the whole title**
  so the next keystroke replaces it; tapping any other title places the caret at
  the tapped character. iOS also keeps a ⋯ → Rename alert as a secondary path. →
  NoteEditorView.swift `TitleTextField` / `isPlaceholderTitle`,
  NoteEditorScreen.kt `isPlaceholderTitle`
- **The native title fields detect and reject illegal titles, matching desktop.**
  A forbidden filesystem char (`< > : " / \ | ? *` or a control char) is stripped
  in place as you type, with a transient (~2 s) warning "That character can't be
  used in a note title"; a leading/trailing dot or a >200-char title shows a
  persistent warning and blocks the rename; a title that duplicates another note
  in the same folder shows "A note with this name already exists" and blocks the
  rename; an empty title is left un-renamed. The rules + messages come from the
  shared `validate_title` exposed over FFI (futo-notes-ffi) — the same
  conformance-locked source as desktop's `validateTitle`; only the forbidden-char
  input filter is mirrored locally per shell. → futo-notes-ffi `validate_title`,
  NoteEditorView.swift, NoteEditorScreen.kt; desktop NotesShell.svelte /
  noteSession.svelte.ts `handleTitleInput`
- **The canonical title→filename sanitizer produces a name legal on EVERY
  platform.** `sanitizeTitle` strips forbidden characters and surrounding
  whitespace, then leading/trailing dots (Windows drops trailing dots; a
  leading dot makes a hidden dotfile the vault scan skips), then de-reserves
  Windows device names (`CON`→`CON_`, `CON.bak`→`CON_.bak`) — so no client mints
  a name that a Windows peer can't hold, and the sync boundary reuses the exact
  same function to HEAL such names on ingress. It is deterministic + idempotent.
  Conformance-locked TS↔Rust (`sanitizeTitle` / `sanitize_title`). → packages/
  editor `filename.ts`, futo-notes-core `files::sanitize_title`;
  tests/conformance/filename.json
- **Android native**'s FAB opens a New note / New folder menu; New folder
  shows a name dialog that sanitizes via the shared rules and rejects
  case-insensitive sibling duplicates inline (verified on emulator
  2026-06-09). → NoteListScreen.kt, NewFolderDialog.kt

## Sidebar tabs *(Tauri)*

- The drawer/sidebar has three tabs: **files** (folder tree + notes),
  **tags**, and **images**. → DrawerSidebar.svelte
- The tags tab lists every tag (lowercased, case-insensitively deduped) with a
  live note count; tapping a tag expands an alphabetical list of its notes;
  tapping a note opens it. Tags inside inline code / fenced blocks are not
  counted. → SidebarTagView.svelte
  (A `$state`-proxy identity bug here used to throw
  `effect_update_depth_exceeded` on render and brick all UI interactivity —
  fixed 2026-06-09, regression-locked by SidebarTagView.test.ts.)
- The images tab lists the vault's images (name, size, date) with a delete
  action; deleting does NOT rewrite notes that reference the image. →
  SidebarImageView.svelte
- The sidebar virtualizes rows (only visible rows render) so 1000+ note vaults
  stay responsive — the files-tab tree computes a `visibleRange`/`visibleNodes`
  window inline over a fixed-height spacer. → FolderTreeView.svelte

## Folder management

- A folder can be created from the new-item affordance ("New Folder").
- Folder names must be unique among siblings (case-insensitive) and
  filesystem-safe; the shared sanitize rules apply. Enforced on Tauri
  (`folders.svelte.ts`), Android (`NewFolderDialog.kt`), and iOS native
  (`NoteListView.swift` `createFolder`): invalid names disable the Create
  action live; non-empty invalid names show the validation error, while an empty
  field stays disabled but quiet. On a case-insensitive sibling match the dialog
  shows "A folder with this name already exists", with the name cleaned via the
  shared Rust `sanitizeTitle`. A hard guard in `createFolder` also blocks the
  idempotent `create_dir_all` from silently merging into an existing folder. →
  folders.svelte.ts, NewFolderDialog.kt, NoteListView.swift
- A folder can be renamed; the rename updates every note path beneath it and
  rewrites wikilinks pointing at those notes. On **Tauri** rename is in the
  folder context menu; on the native shells it belongs in the folder long-press
  menu alongside Move and Delete. → folders.svelte.ts,
  `apps/tauri/src-tauri/src/folder_commands.rs`
  > **Gap:** the native shells expose no folder-rename affordance yet — the
  > folder long-press menu offers Delete only (iOS `NoteListView.swift`, Android
  > `NoteListScreen.kt`), and the shared `NoteStore` FFI facade has no
  > rename-folder primitive. *(native shells)*
- Notes and folders can be moved by drag-and-drop in the tree (note → folder,
  folder → folder, folder → root). A name collision on move resolves with a
  `-2`/`-3` suffix. Hovering a folder while dragging auto-expands it. →
  FolderTreeView.svelte *(desktop)*
  > **Gap:** the native shells can move a *note* into a folder ("Move to
  > Folder…") but expose no folder-move affordance — moving a folder itself
  > belongs in the folder long-press menu alongside Rename and Delete, and the
  > shared `NoteStore` FFI facade has no move-folder primitive. *(native
  > shells)*
- A folder can be **deleted**, behind a destructive confirmation ("Delete
  this folder? Notes inside it will be moved to the parent folder."), with
  **one converged semantic on every surface**: non-destructive move-up —
  contained notes move to the parent folder (the deleted path segment is
  removed, deeper structure shifts up; name collisions resolve with the
  `-2`/`-3` suffix), wikilinks pointing at moved notes are rewritten, and
  only then is the empty folder removed. Sync sees note moves, not
  tombstones. If any note fails to move, the delete bails and nothing is
  removed. (An earlier note here describing an iOS-native recursive-destroy
  delete was stale — no native folder delete existed in code until this
  one.) Verified on emulator + simulator 2026-06-09.
  - **Tauri**: folder context menu → Delete. The frontend first moves/relinks
    every note, then the Rust folder command removes the empty tree through the
    desktop trash policy. → DrawerSidebar.svelte `confirmDeleteFolder`,
    `apps/tauri/src-tauri/src/folder_commands.rs`,
    `apps/tauri/src-tauri/src/system_trash.rs`
  - **iOS native**: folder row swipe or long-press "Delete Folder…". →
    NoteListView.swift
  - **Android native**: drawer folder row long-press → "Delete folder",
    with a "Folder deleted; moved N notes" toast. → NoteListScreen.kt
  - The native shells share the Rust primitive (rejects the vault root and
    path traversal; a missing folder is a no-op; relinks each moved note).
    → futo-notes-model `crud::delete_folder_move_up`, futo-notes-ffi
    `NoteStore::delete_folder`
