## Folder browsing

**Both native shells browse folders by pushing screens**; neither has a drawer,
an "All notes" entry, or per-folder note counts anywhere in the UI. _(Android
gained this model 2026-08-25, replacing its `ModalNavigationDrawer`.)_

- A folder screen shows that folder's **immediate subfolders as a block above
  its own notes**, in one scrolling list — never interleaved. Tapping a
  subfolder row **pushes** a screen for that folder; the screen is recursive, so
  any depth is reachable one level at a time. → NoteListView.swift
  `FolderContentsView` _(iOS)_; NoteListScreen.kt `NoteListScreen(folder=…)`
  _(Android)_
- **The vault root IS the home screen** (root notes + top-level folders). There
  is no flat cross-folder note list on the native shells; search is the
  cross-folder view. → NoteListView.swift, NoteListScreen.kt
- The subfolder block is derived **client-side** from the engine's flat list of
  full folder paths by one prefix filter — no extra engine call. It arrives
  alphabetical because Rust emits the folder projection from a `BTreeSet`, and
  every ancestor path is present, which is what makes every folder reachable by
  tapping down. Notes keep engine order verbatim (ADR-0001). → futo-notes-store
  `vault::note_order_and_folders`; NotesStore.swift `subfolders(of:)`,
  NotesStore.kt `immediateSubfolders` / FolderActionsTest
- The screen is titled with the folder's **last path component**; the root is
  titled "Notes". System Back (and, on Android, the top-bar up arrow) pops one
  level; the root has no up affordance because it is the stack floor.
  → NoteListView.swift, NoteListScreen.kt / AppNavigation.kt
- **Settings is a nav/top-bar gear** on every folder screen, and Sync is reached
  from Settings on Android / a nav-bar **cloud** button on iOS. → NoteListView.swift
  toolbar _(iOS)_; NoteListScreen.kt top bar → SettingsScreen.kt → SyncScreen.kt
  _(Android)_
- Each folder screen keeps its **own** scroll position across a note, a deeper
  folder, Search, or Settings. _(Android)_ → NoteListState.kt /
  NoteListStateTest.kt
- Browsing the folder being renamed or moved **follows it** (the pushed screens
  rebase onto the new path); browsing a folder that stops existing — deleted
  locally or by a sync pull — **pops to the nearest surviving ancestor**, never
  to a dead screen. A note open above such a folder stays open; only where Back
  lands changes. _(Android)_ → AppNavigation.kt `rebaseFolderRoutes` /
  `pruneFolderRoutes`, AppNavStackTest.kt / AppNavigationTest.kt
- A pulled deletion prunes the directories it vacates, exactly like the local
  delete/move workflows: a folder deleted on one client does not survive as an
  empty ghost folder on syncing peers, while an intentionally-empty folder no
  pulled change touched is never pruned. →
  futo-notes-store `refresh_external_changes` + `prune_empty_parents`,
  crates/futo-notes-store/src/tests.rs
  `reported_external_changes_prune_the_directories_the_pull_vacated`
- **Tauri** keeps its own model: a **tabbed folder tree** sidebar (files / tags /
  images — see [Sidebar tabs](sidebar-tabs.md#sidebar-tabs-tauri)) with no "All notes" row and
  no per-folder note counts. → DrawerSidebar.svelte / FolderTreeView.svelte
- *(desktop)* The sidebar/list footer carries the ambient license label
  ("Unlicensed", and nothing at all once Licensed) and nothing else — the app
  version no longer shares that line; clicking it opens Settings at the License
  section. See [license.md](../license.md).
