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
  sibling collision its sanitized form would hit. Android routes create and
  rename through one dialog (`NewFolderDialog.kt` `folderNameVerdict`); iOS shares one validator between
  its create and rename dialogs (`FolderNameValidation.swift`
  `folderNameProblem`). A committed create toasts
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
  - **iOS native**: folder row swipe or long-press "Delete Folder…" opens one
    centered card (`FolderDeleteDialog`) and tints the folder's row while it is
    up. The count is every note in the folder and its subfolders. An empty
    folder (0 notes) asks "Delete “Name”? This folder is empty." with Cancel |
    Delete. A folder with notes asks "Its N notes will be kept unless you delete
    them too." with **Delete folder only** (the move-up delete above, preferred),
    **Delete folder and notes…** and Cancel. After Delete folder only the row
    disappears and a toast "Kept N notes from “Name”" shows for about 3 s.
    **Delete folder and notes…** morphs the same card into a second step:
    "Delete N notes?", a warning that “Name” and every note in it are deleted
    from all devices and can't be undone, the first 3 note titles plus "… and K
    more", and Back | **Delete all**. Delete all is disabled for 0.6 s after the
    step appears (a warning haptic fires then), so a double-tap on step 1 cannot
    reach it. Delete all permanently deletes every note under the folder
    (iOS has no trash), then removes the folder; sync propagates each note
    deletion as it would a single delete, and non-note files move up as in the
    native primitive below, never deleted. Reduce Motion replaces the scale and
    spring with crossfades; at large Dynamic Type the card scrolls and side-by-side
    buttons stack. → FolderDeleteDialog.swift,
    `futo-notes-store::LocalNoteStore::delete_folder_and_notes`,
    `deleting_a_folder_and_its_notes_removes_every_note_but_keeps_attachments`
    > **Gap (parity):** Tauri offers no "delete the folder and its notes" choice, only
    > the move-up delete; the Rust primitive is exposed through the shared FFI. Desktop
    > would need a trash policy for the notes.
  - **Android native**: in-list folder row long-press → "Delete folder" opens the
    same two-step flow as iOS (counts, strings and the 0.6 s Delete all arming are
    identical; an empty folder keeps the plain confirm and its "Folder deleted"
    toast), drawn as a Material 3 dialog: step 1 stacks **Delete folder only**
    (tonal, orange), **Delete folder and notes…** (outlined, error colour) and Cancel;
    step 2 is the same dialog animating in place (fade plus size change; only fades
    when the system animator scale is 0), with a trash hero icon, the first 3 titles
    plus "and K more", and Back | **Delete all** at the bottom right, a reject haptic
    (`HapticFeedbackConstants.REJECT`, API 30+, else long-press) when it appears.
    The dialog scrolls at large font scale. The folder's row is tinted while the
    dialog is up. After Delete folder only a toast "Kept N notes from “Name”" shows,
    and notes that landed in the list (ids not in it before) are tinted for about 2 s;
    after Delete all the row just disappears. The puppet refuses DeleteAllNotes while
    disarmed (409). Deleting the folder a pushed screen is showing pops that screen
    (see [Folder browsing](folder-browsing.md#folder-browsing)). Verified on the
    emulator 2026-11-16 (disk: notes deleted, non-note files moved up). →
    FolderDeleteDialog.kt, NoteListDialogs.kt, `NotesStore.deleteFolderAndNotes`
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
