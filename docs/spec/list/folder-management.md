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
  supplies the noun rather than the manifest. Every shell reaches the
  `forbidden_chars` verdict out of the shared Rust `validateTitle` rather than
  carrying its own character list, and reports a name rule **before** the
  sibling collision its sanitized form would hit. Android routes create,
  rename and the folder picker's "New folder…" through one dialog
  (`NewFolderDialog.kt` `folderNameVerdict`); iOS shares one validator between
  its create and rename dialogs (`FolderNameValidation.swift`
  `folderNameProblem`). A committed create toasts
  "Folder created". A hard guard in `createFolder` also blocks the
  idempotent `create_dir_all` from silently merging into an existing folder. →
  folderOperations.ts, NewFolderDialog.kt, NoteListView.swift

  > **Gap:** _(iOS)_ the **Move to Folder…** sheet's inline "New Folder…"
  > validates nothing. It is a plain `.alert` guarded only by
  > `guard !name.isEmpty`, so it accepts a forbidden character, a
  > case-insensitive duplicate and a name that sanitizes away — none of
  > which the New Folder and Rename dialogs allow any more. Android's
  > folder-picker "New folder…" shares the validated dialog and is not
  > affected. Closing this means the alert has to become a live-rendering
  > dialog like the other two so it can show a message at all.
  > → NoteListView.swift (`MoveToFolderSheet`, `createAndMove`)
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
    showing pops that screen (see [Folder browsing](folder-browsing.md#folder-browsing)). →
    NoteListScreen.kt, FolderDeleteToastTest.kt
  - The native shells share the Rust primitive (rejects the vault root and
    path traversal; a missing folder is a no-op; relinks each moved note).
    Remaining images and other files move up with their relative subfolder
    paths. An existing destination is never replaced; a numbered filename
    preserves the moved file instead. A collision may require a manual update
    to a Markdown image link that names the original file. If a file cannot
    move, the source folder remains with those bytes and the mutation reports
    a cleanup warning. This gives app-private Android and iOS vault files a
    recoverable location without relying on a platform trash service. →
    `futo-notes-store::LocalNoteStore::delete_folder`,
    `native_folder_delete_preserves_nested_attachments_and_name_collisions`
    → futo-notes-store `LocalNoteStore::delete_folder`, futo-notes-ffi
    `NoteStore::delete_folder`
