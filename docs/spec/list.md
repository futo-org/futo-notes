# Note List — Spec

The home screen: notes in the current folder, a folder drawer, and search /
new-note affordances.

## Home ("For You") *(Tauri)*

- With no note open, the main pane shows a "For You" feed of recent-note cards
  (title, preview, relative modified time); tapping a card opens the note.
  Cards reorder as notes are edited. → ForYouPage.svelte
- An empty vault shows "Create your first note" with a "Browse notes" button
  (opens the drawer) and, on mobile, a "Quick capture" button.
- Quick capture creates a new note and opens it ready to type. Backing out of
  an untouched quick-capture note leaves no note behind. Verified on Android
  Tauri 2026-06-09.

## List

- Shows the notes in the current folder, or all notes when "All notes" is
  selected. → NoteListScreen.kt
- Notes are sorted most-recently-modified first. **Opening a note does not count
  as modifying it** — only an actual content or title change moves a note to the
  top.
- Tapping a note opens it in the editor (no autofocus). → NoteListScreen.kt /
  MainActivity.kt
- An empty folder shows an empty state ("Nothing here yet").
- The top bar is transparent at rest and gains a surface fill + bottom border
  once the list is scrolled. *(Android)*

## Folder drawer

- Opened from the menu icon (or an edge swipe). Lists "All notes" first, then
  each folder path, each with a live note count. → NoteListScreen.kt
- Selecting a folder filters the list and closes the drawer.
- A Settings entry sits at the bottom of the drawer.

## New note

- The FAB creates an "Untitled" note in the current folder (the vault root when
  "All notes" is selected) and opens it with the title autofocused. →
  NoteListScreen.kt
  > **Gap:** the Tauri mobile shell focuses the **body**, not the title, for
  > both "+ New" and Quick capture (observed Android Tauri 2026-06-09).

## Note actions (menu)

- An open note's overflow menu offers: **Graph view** (stub — toast
  "coming soon"), **Copy file path** (full filesystem path to clipboard),
  **Move to folder**, **Delete note**. The same menu appears on desktop and
  Tauri mobile. → NotesShell.svelte note menu
- "Move to folder" opens a folder picker (root "Notes" + folder tree, nesting
  shown); picking a destination moves the file, keeps the note open under its
  new id, and rewrites backlinks. Verified on Android Tauri 2026-06-09. →
  FolderPickerModal.svelte
- "Delete note" asks for confirmation ("This action cannot be undone."), then
  deletes **permanently** — there is no trash in the UI flow. Deleting the
  only note in a folder prunes now-empty ancestor folders. →
  platform/tauri.ts `deleteNoteFile` (a `notes_delete_to_trash` command exists
  but no UI calls it)
- A note row in the folder tree offers the same Move/Delete via context menu
  (desktop right-click / mobile long-press). → FolderTreeView.svelte
  > **Gap:** the native Android editor menu has **only** "Delete note" — no
  > move, no copy-path. iOS native's editor menu is thinner still (Rename
  > only; share/delete/move live on the list rows). **Both native shells
  > delete immediately with no confirmation** (verified on emulator + sim
  > 2026-06-09) — a data-safety divergence from the Tauri confirm dialog.
- **iOS native** note rows expose **Move to Folder…** and **Delete** via
  long-press context menu / swipe actions; the move sheet lists Root, every
  folder, and an inline "New Folder…" option, and the move is applied on
  disk immediately (verified 2026-06-09). → NoteListView.swift
  > **Gap:** Android native has no move UI at all (`store.moveNote()` exists,
  > nothing calls it).
- **iOS native** creates notes via a title dialog (prefilled "Untitled",
  Cancel/Create) from a "+" menu offering New Note / New Folder; the editor
  then opens with the **body** focused. Android native opens the editor with
  the title focused instead; the title-dialog flow is iOS-only. →
  NoteListView.swift
  > **Gap:** Android native has no New Folder affordance.

## Sidebar tabs *(Tauri)*

- The drawer/sidebar has three tabs: **files** (folder tree + notes),
  **tags**, and **images**. → DrawerSidebar.svelte
- The tags tab lists every tag (lowercased, case-insensitively deduped) with a
  live note count; tapping a tag expands an alphabetical list of its notes;
  tapping a note opens it. Tags inside inline code / fenced blocks are not
  counted. → SidebarTagView.svelte
  > **Gap:** on Android Tauri, rendering the tags tab throws an uncaught
  > Svelte `effect_update_depth_exceeded` and all UI interactivity dies until
  > reload (observed 2026-06-09, emulator). Suspect the `$effect` cache-key
  > write in SidebarTagView. Desktop unverified.
- The images tab lists the vault's images (name, size, date) with a delete
  action; deleting does NOT rewrite notes that reference the image. →
  SidebarImageView.svelte
- The sidebar virtualizes rows (only visible rows render) so 1000+ note vaults
  stay responsive. → VirtualList.svelte

## Folder management

- A folder can be created from the new-item affordance ("New Folder").
- Folder names must be unique among siblings (case-insensitive) and
  filesystem-safe; the shared sanitize rules apply. → folders.svelte.ts
- A folder can be renamed; the rename updates every note path beneath it and
  rewrites wikilinks pointing at those notes. → folders.svelte.ts *(Tauri)*
- Notes and folders can be moved by drag-and-drop in the tree (note → folder,
  folder → folder, folder → root). A name collision on move resolves with a
  `-2`/`-3` suffix. Hovering a folder while dragging auto-expands it. →
  FolderTreeView.svelte *(desktop)*
- A folder can be **deleted**, which **recursively removes the folder and all of
  its contents** (every note and subfolder beneath it). The action requires a
  destructive confirmation that states how many notes will be deleted, and it
  cannot be undone. → core `delete_folder` (rejects the vault root and path
  traversal; a missing folder is a no-op).
- A folder delete propagates over sync like a multi-note delete: the removed
  files are gone from disk, and the next push tombstones each of them on the
  server (the push diffs disk vs the object map — see [sync.md](sync.md)).
- **iOS native:** swipe-to-delete or a long-press "Delete Folder…" context menu
  on a subfolder row in the folder browser. → NoteListView.swift
  > **Gap:** desktop (Tauri) and Android do not yet expose a folder-delete UI;
  > the shared core `delete_folder` is available for them to wire up.
