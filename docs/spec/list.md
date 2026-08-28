# Note List — Spec

The home screen: the vault root's folders and notes, folder browsing, and search
/ new-note affordances.

## Home ("For You") _(Tauri)_

- With no note open, the main pane shows a "For You" feed of recent-note cards
  (title, preview, relative modified time); tapping a card opens the note.
  Cards reorder as notes are edited. → ForYouPage.svelte
- The feed shows the **three** most recently modified notes — the head of the
  engine-ordered note list (a slice; the shell holds no comparator of its
  own); card previews truncate to 60 characters. → forYou.ts
- Relative modified times in the desktop feed and images view and in Android
  and iOS note rows resolve through each shell's catalog-backed
  `localizedRelativeTime`. → shared/localization/localization.ts, Android
  `localization/Localization.kt`, iOS `Localization/Localization.swift`
- An empty vault shows a **"FUTO Notes"** heading. On mobile the subtitle reads
  "Create your first note to get started." with a **"Browse notes"** button
  (opens the drawer) and a **"Quick capture"** button below the feed area; on
  desktop only the subtitle "Create your first note from the sidebar to get
  started." shows (both buttons are mobile-only). → ForYouPage.svelte
- Quick capture creates a new note and opens it ready to type. Backing out of
  an untouched quick-capture note leaves no note behind. Verified on Android
  Tauri 2026-06-09.

## List

- Shows the notes whose parent folder is exactly the folder being browsed
  (see [Folder browsing](#folder-browsing)); on Tauri, the notes of the folder
  selected in the sidebar tree. → NoteListScreen.kt _(Android)_,
  NoteListView.swift _(iOS)_
- Notes are sorted most-recently-modified first, id ascending on a modified
  tie. The sort rule lives **only in the Rust engine** (ADR-0001): snapshots
  arrive sorted, and every committed mutation carries each affected note's
  **final id** and its **position** in the sorted list (positions defined
  after removals), together with the post-commit folder projection. All three
  shells apply that result directly—no shell-side sort, identity rule, or
  follow-up folder scan. Positions are clamped so a stale value cannot crash.
  **Opening a note does not count as modifying
  it** — only an actual content or title change moves a note to the top. →
  futo-notes-store `vault::note_list_order` / `place_upserted`;
  notes.svelte.ts `_applyLocalMutation`, NotesStore.swift / NotesStore.kt
  `applyMutation`
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
  > `reloadAsync` sync-pull path has no at-top re-pin yet. → NotesStore.kt
  > `reloadAsync`, AppNavigation.kt `AppNavigator.goBack`
- Tapping a note opens it in the editor (no autofocus). → NoteListScreen.kt /
  AppNavigation.kt
- The list keeps the folder it is browsing and that folder's scroll position
  through a note, Search, or Settings. Returning restores both; after the initial
  vault load, a folder that no longer exists pops to the nearest surviving
  ancestor (see [Folder browsing](#folder-browsing)). → NoteListState.kt /
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
- Preview text is never interactive: tapping anywhere on a note row — including
  preview text that looks like a URL — always opens the note, never a link.
  _(iOS native)_ `AttributedString(markdown:)` auto-attaches a `.link`
  attribute to URL-shaped preview text; `NoteRow.stripLinkAttributes` removes
  it from every run before render so the row's `NavigationLink` always gets
  the tap. → NoteListView.swift `NoteRow`

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
- `NotesStore.noteCount(under:)` exists on iOS but is only used for delete
  confirmation text, never surfaced as a per-folder count. → NoteListView.swift
- **Tauri** keeps its own model: a **tabbed folder tree** sidebar (files / tags /
  images — see [Sidebar tabs](#sidebar-tabs-tauri)) with no "All notes" row and
  no per-folder note counts. → DrawerSidebar.svelte / FolderTreeView.svelte

## Sidebar drag & drop _(desktop)_

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
  `dragDropEnabled` on, deliberately: of wry's three backends only webview2
  (RegisterDragDrop on the HWND) and wkwebview (draggingEntered /
  performDragOperation overrides) install a native layer that eats internal
  drags — webkitgtk only connects GTK signal handlers that return false, never
  calling `drag_dest_set`, so a Linux build has nothing to turn off. Verified
  on the real Linux app with X11 pointer input: note-into-folder fires the full
  dragstart/dragenter/dragover/drop sequence and moves the file, and a tab drag
  reorders the strip. → wry webkitgtk/drag_drop.rs, dragDropConfig.test.ts
- The custom drag-image ghost (a 1×1 canvas to suppress the OS image + a DOM
  mirror that follows the cursor) is **WebKitGTK-only** (`isLinux`). WebKitGTK
  needs it because it rasterizes the OS drag image blurry on hi-DPI; macOS
  WKWebView and Windows WebView2 render native drag images crisply. Critically,
  it must NOT run on WKWebView: mutating the DOM during `dragstart` aborts the
  drag there (dragstart → dragend, zero dragover) — a separate failure from the
  wry interception above; both had to be fixed for macOS drag & drop to work
  (2026-07-08). → FolderTreeView.svelte `setControlledDragImage`

## New note

- **New note and New folder are two separate one-tap controls on every
  platform** (github#5: a "+" that opened a menu put quick capture behind an
  extra tap). Desktop: the "+ New" button and its folder-icon sibling
  (SidebarCreateActions.svelte). Android: the "+" FAB is a plain "New note" and a
  folder-plus action icon ("New folder") sits in the top app bar before Search
  and Settings (the Material 3 home for a secondary create action; a stacked
  small FAB was tried and rejected as a non-M3 speed dial). iOS: a folder-badge-plus
  button and a compose button side by side in the trailing nav bar. Neither
  shell has a create menu any more. → SidebarCreateActions.svelte,
  NoteListScreen.kt, NoteListView.swift
- The New-note control creates an "Untitled" note in the folder being browsed
  (the vault root on the root screen) and opens it with the **body** focused for
  quick capture (keyboard on the note text, not the title). The New-folder
  control likewise creates in the folder being browsed, so both are reachable at
  every depth. → NoteListScreen.kt, NoteListView.swift
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
- Move and Delete act on the note the action was started for, not on one selected
  while the action's own save flush runs. Holds for the sidebar's right-click menu
  too. _(Tauri)_ → `noteActionTarget.ts`, `createCurrentNoteActions.svelte.ts`,
  `sidebarFolderMutations.ts`
- They follow that note through the identity a save gave it — the rename a title
  edit commits, or the id a first save mints for an unsaved draft — so renaming or
  starting a note and then moving or deleting acts on that file. This holds
  whichever way the race falls: the menu captures the pre-rename id, and the
  commit may land either before or after the action begins. _(Tauri)_
- They act on nothing, and toast "That note is no longer available", when the
  picked note disappears for any other reason (a sync pull or an external delete
  mid-action) — never falling through to whatever note is open by then. _(Tauri)_
- "Delete note" asks for confirmation, then deletes the file. _(Desktop)_ routes
  through the OS trash — recoverable via the OS trash — falling back to permanent
  delete if the platform trash is unavailable (e.g. headless CI). In a Flatpak
  sandbox the host trash directory is unreachable, so a delete inside the vault the
  sandbox was granted routes through the `org.freedesktop.portal.Trash` portal
  instead, with the same permanent-delete fallback. _(iOS, Android)_ delete
  permanently; there
  is no trash in the native UI flow. Sync is unaffected either way — the file
  leaving the vault tombstones the note on the next sync exactly as a
  permanent delete would. Deleting the only note in a folder prunes now-empty
  ancestor folders on every platform. Desktop supplies the trash policy to the
  shared local-note store; native shells delete directly. →
  `futo-notes-store::LocalNoteStore::delete_with`, `local_notes_delete`
- _(Desktop)_ The confirmation says what the active vault can actually recover:
  "This action cannot be undone." where a trash exists, and "This deletes the file
  for good — it does not go to the trash." on a vault with no reachable trash. It
  never implies a recovery the vault cannot deliver. _(iOS, Android)_ always say
  "This action cannot be undone.", which is exact — those shells have no trash by
  design. → `vault_status.deletesArePermanent`,
  `src/features/notes/deleteConfirmation.ts`
- _(Desktop, Flatpak only)_ A notes folder picked inside the sandbox has **no
  trash at all**: `org.freedesktop.portal.Trash` declines a document-portal path
  outright, while taking the same file under `$HOME`. Deletes there skip the
  doomed portal call and hard-delete, and the confirmation says so. Verified
  against a live portal by
  `system_trash::tests::portal_trash_declines_a_document_portal_path`. →
  `system_trash::deletes_are_permanent`

- _(Desktop, Flatpak only)_ **A deleted folder's emptied shell never reaches the
  trash**, even on a vault whose notes do: the Trash portal accepts only regular
  files (a directory cannot be opened `O_RDWR`, and the portal declines the
  `O_PATH` descriptor — pinned live by
  `system_trash::tests::portal_trash_declines_a_directory`). Notes are always
  moved to the parent first, so what is permanently removed is the emptied tree
  plus any stray non-note files inside it — and the confirmation says so:
  "… Anything else inside it is deleted for good." A non-Flatpak desktop build
  trashes the shell through `trash::delete` and asks the plain question. →
  `system_trash::folder_deletes_are_permanent`, deleteConfirmation.ts
  `folderDeleteWarning`
- A note row in the folder tree offers the same Move/Delete via context menu
  (desktop right-click / mobile long-press). → FolderTreeView.svelte
- A note row in the folder tree offers Rename / Move to folder / Delete via
  context menu (desktop right-click / mobile long-press). → FolderTreeView.svelte
- _(desktop)_ **A note row renames inline**, by the same three gestures as a
  folder row: double-click, F2 on the focused row, or the context menu's
  **Rename**. The field opens seeded with the current name and selected; Enter
  commits, Escape cancels, and clicking away commits. The typed text becomes the
  filename verbatim — trailing whitespace aside, nothing is prettified (AGENTS.md
  M2) — and the rename is one `move` mutation through the shared store, so
  backlinks, the open tab, and the note cache follow it. Illegal names are
  rejected with the shared title rules and messages ("That character can't be
  used in a note title", "A note with this name already exists"), never
  sanitized into a different name. → FolderTreeNoteRow.svelte,
  TreeRowRename.svelte, sidebarFolderMutations.ts `renameSidebarNote`
- The native editor menus reach parity: **Android** ⋮ offers Move to
  folder… / Copy file path / Delete note (Share is a dedicated top-bar
  action); **iOS** ⋯ offers Rename / Move to Folder… / Copy File Path /
  Share / Delete Note. A move keeps the note open under its new id; the same
  `NoteStore.moveNote` workflow relinks backlinks. **Every destructive delete on the
  native shells asks for confirmation** ("Delete this note? This action
  cannot be undone.") — editor menus, list rows, swipe actions, and search
  results alike (verified on emulator + simulator 2026-06-09). →
  NoteEditorScreen.kt, NoteEditorView.swift, ConfirmDialog.kt
  > **iOS native**: the delete-note and delete-folder confirmations render as a
  > centered, non-anchored card (a transparent `fullScreenCover`), never as an
  > arrow popover. `.confirmationDialog`, attached at a container view far from
  > the swiped/long-pressed row, could render as a popover anchored to that
  > container in a regular-width horizontal size class (some large iPhones) —
  > pointing the arrow at an unrelated row instead of the one being deleted
  > (fixed 2026-07-22). The editor menu uses the same presentation, and opening
  > its cover does not trigger editor-leave draft cleanup. →
  > DestructiveConfirmDialog.swift, NoteListView.swift, NoteEditorView.swift
- **iOS native** note rows expose **Move to Folder…** and **Delete** via
  long-press context menu / swipe actions; the move sheet lists Root, every
  folder, and an inline "New Folder…" option, and the move is applied on
  disk immediately (verified 2026-06-09). → NoteListView.swift
- **Android native** note rows expose the same Move to Folder… / Delete via
  long-press; the move sheet matches iOS (Root, every folder, inline "New
  Folder…") and applies the move + backlink relink immediately, with a
  "Moved to {folder}" toast. Its shared file placement falls back down the
  no-replace install chain when Android storage rejects hard links — an atomic
  no-replace rename on Android 11+, an exclusive create plus copy on the
  Android 9/10 sdcardfs that rejects flagged renames too (see app.md) — so
  create/move never
  overwrites a note that appears concurrently (verified on emulator 2026-07-21;
  race regression added 2026-07-21). →
  NoteListScreen.kt, FolderPickerSheet.kt
- Android note delete/move actions consume an explicit committed/failed store
  outcome. Success toasts, editor navigation, note-id changes, and move-sheet
  dismissal occur only after commit. On failure the editor/list and current
  folder identity remain in place, the move picker stays open for retry, and a
  failure toast states that the note was not deleted or moved. Creating an
  inline destination folder is likewise a prerequisite: its failure stops the
  move. The standalone New Folder dialog also dismisses only after a committed
  create; failure leaves it open for retry and shows a failure toast. →
  NotesStore.kt, NoteEditorScreen.kt, NoteListScreen.kt,
  NoteActionCompletionTest
- Android's FAB → New note consumes the same explicit outcome: the editor opens
  only on a committed create, and a failed create says "Couldn't create note.
  Try again." rather than leaving the list unchanged with no message — the
  silence github#13 reported. → NotesStore.kt `createNote`, NoteListScreen.kt
- **Both native shells create notes as quick capture** (iOS compose button;
  Android "+" FAB): an "Untitled" note is created in the current
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
- **A title longer than the screen never widens the editor** on any of the
  three apps. The title field takes the width of the editor column and no more,
  so an over-long title is cut off at the column edge rather than pushing
  itself — or the note body beside it — off-screen; while editing, the field
  scrolls to follow the caret. How the overflow reads differs by platform and
  is cosmetic: iOS ellipsizes the unfocused title, Android clips it mid-glyph.
  iOS needs `TitleTextField.sizeThatFits` to report the proposed width, because
  a `UIViewRepresentable` otherwise sizes itself to the text's natural width and
  drags the whole editor VStack — embedded web view included — with it; Android
  and desktop are pinned declaratively (`fillMaxWidth()`, `width: 100%`).
  _(verified iOS simulator + Android emulator 2026-07-27)_ →
  NoteEditorView.swift `TitleTextField`, TitleTextFieldLayoutTests,
  NoteEditorScreen.kt `BasicTextField`, NoteWorkspace.svelte `.title-input`
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
  platform.** `sanitizeTitle` strips the visible filesystem delimiters plus the
  full Unicode Cc control category, then repeatedly removes surrounding
  whitespace and leading/trailing dots until the result settles (Windows drops
  trailing dots; a leading dot makes a hidden dotfile the vault scan skips).
  Dot-and-space-only inputs become `Untitled`; Windows device names are
  de-reserved (`CON`→`CON_`, `CON.bak`→`CON_.bak`). No client therefore mints a
  name a Windows peer cannot hold, and the sync boundary reuses the exact same
  function to HEAL such names on ingress. It is deterministic + idempotent.
  The reviewed goldens and broad differential corpus lock TS↔Rust
  (`sanitizeTitle` / `sanitize_title`). → packages/editor `filename.ts`,
  futo-notes-core `files::sanitize_title`;
  tests/conformance/{filename.json,title-rules-differential.mjs}
- **Android native**'s top-bar New-folder action shows a name dialog that sanitizes
  via the shared rules and rejects case-insensitive sibling duplicates inline
  (verified on emulator 2026-06-09, as a FAB-menu item then). →
  NoteListScreen.kt, NewFolderDialog.kt

## Sidebar tabs _(Tauri)_

- The drawer/sidebar has three tabs: **files** (folder tree + notes),
  **tags**, and **images**; the selected tab persists across sessions
  (localStorage `futo-notes:sidebarView`). → DrawerSidebar.svelte
- Clicking the sidebar brand/home affordance returns to the For You home (no
  note open). → DrawerSidebar.svelte
- The tags tab lists every tag (lowercased, case-insensitively deduped) with a
  live note count; tapping a tag expands an alphabetical list of its notes;
  tapping a note opens it. Tags inside inline code / fenced blocks are not
  counted. → SidebarTagView.svelte
  (A `$state`-proxy identity bug here used to throw
  `effect_update_depth_exceeded` on render and brick all UI interactivity —
  fixed 2026-06-09, regression-locked by SidebarTagView.test.ts.)
- The images tab shows the vault's images as a thumbnail grid (live
  previews); tapping a thumbnail opens a full-size detail view with a Back
  control, the image's name, size, and relative-time date, and an overflow
  (⋮) menu hosting **Delete**. Deleting does NOT rewrite notes that reference
  the image. → SidebarImageView.svelte
- The sidebar files tree stays responsive on large vaults (target: 10,000
  notes) — scrolling, expanding/collapsing, and drag & drop remain usable.
  The implementation is not required to virtualize rows. → FolderTreeView.svelte
- Scrolling the files tree never shows an empty sidebar: however fast the list is
  flung, every painted frame shows rows. _(Tauri)_ → FolderTreeView.svelte
  > **Gap:** a single isolated frame can still paint the spacer when the scroll
  > jumps further than the virtual window's lead — measured 5 lone frames in
  > ~1,300 native window captures, never two in a row.
  > → docs/perf/tab-switch-baseline.md
- Every folder-tree note, folder, and empty-state row spans the remaining
  sidebar width after its nesting indent, so hover, selection, context-menu,
  and drag/drop hit zones stay full-width at every depth. → folderTree.css

## Folder management

- A folder can be created from the new-item affordance ("New Folder").
- Creating, renaming, moving, or deleting notes and folders returns one
  committed store mutation containing both ordered note changes and the final
  folder projection. Shells do not rescan the vault after local workflows.
- Folder names must be unique among siblings (case-insensitive) and
  filesystem-safe; the shared sanitize rules apply. Enforced on Tauri
  (`folderOperations.ts`), Android (`NewFolderDialog.kt`), and iOS native
  (`NoteListView.swift` `createFolder`): invalid names disable the Create
  action live; non-empty invalid names show the validation error, while an empty
  field stays disabled but quiet. On a case-insensitive sibling match the dialog
  shows "A folder with this name already exists", with the name cleaned via the
  shared Rust `sanitizeTitle`. Folder-name violations are worded for a FOLDER
  ("That character can't be used in a folder name", "Folder name cannot be
  empty") — the shared rules are layered on `validateTitle`, so the surface
  supplies the noun rather than the manifest. A committed create toasts
  "Folder created". A hard guard in `createFolder` also blocks the
  idempotent `create_dir_all` from silently merging into an existing folder. →
  folderOperations.ts, NewFolderDialog.kt, NoteListView.swift
- A folder can be renamed; the rename updates every note path beneath it and
  rewrites wikilinks pointing at those notes. Every folder row exposes the same
  discoverable action set: **Rename**, **Move to Folder…**, **Delete** — through
  right-click on the desktop sidebar tree and long-press on an **in-list folder
  row** on iOS/Android (Android's drawer rows carried it until 2026-08-25).
  Rename validates the new name against the shared folder-name rules and
  case-insensitive siblings before committing one `rename_folder` mutation. →
  folderOperations.ts,
  NoteListView.swift, NoteListScreen.kt
- _(desktop)_ Rename is also inline from a **double-click** on the row or **F2**
  on the focused row. The typed text is a NAME, not a path: a `/` in it is an
  illegal character, never an instruction to nest the folder somewhere new
  (`renameFolderInPlace`, regression-locked 2026-08-19 — the old code spliced the
  text into the destination path, so "a/b" silently moved the folder into a new
  "a"). A rejected name is REPORTED as a toast and the edit stays in the field,
  still focused and still fixable; it is never discarded, and the only feedback
  is never a bare red outline. → folderOperations.ts `renameFolderInPlace`,
  FolderTreeFolderRow.svelte, TreeRowRename.svelte
- A folder can be moved to Root or any existing folder except itself or one of
  its descendants. The picker omits those invalid destinations. The shared
  `move_folder` workflow preserves the entire subtree, rewrites wikilinks to
  every moved note, and returns the collision-resolved final folder path; a
  sibling collision resolves with `-2`/`-3`, never an overwrite. Desktop also
  supports drag-and-drop in the tree (folder → folder, folder → root), and
  hovering a folder while dragging auto-expands it. The context-menu picker and
  drag-and-drop call the same store workflow. → futo-notes-store
  `LocalNoteStore::move_folder`, FolderTreeView.svelte / DrawerSidebar.svelte,
  NoteListView.swift, FolderPickerSheet.kt
  Moving a note creates its destination directory as part of the same Rust
  workflow; native folder pickers do not issue a separate create-folder call.
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
  - **Tauri**: folder context menu → Delete. One Rust store workflow moves and
    relinks every note before removing the remaining tree through the desktop
    trash policy. → DrawerSidebar.svelte `confirmDeleteFolder`,
    `apps/tauri/src-tauri/src/local_notes.rs`, `futo-notes-store`,
    `apps/tauri/src-tauri/src/system_trash.rs`
  - **iOS native**: folder row swipe or long-press "Delete Folder…". →
    NoteListView.swift
  - **Android native**: in-list folder row long-press → "Delete folder", with a
    "Folder deleted; moved N notes" toast. Deleting the folder a pushed screen is
    showing pops that screen (see [Folder browsing](#folder-browsing)). →
    NoteListScreen.kt, FolderDeleteToastTest.kt
  - The native shells share the Rust primitive (rejects the vault root and
    path traversal; a missing folder is a no-op; relinks each moved note).
    → futo-notes-store `LocalNoteStore::delete_folder`, futo-notes-ffi
    `NoteStore::delete_folder`
