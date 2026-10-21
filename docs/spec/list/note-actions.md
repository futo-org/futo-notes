## Note actions (menu)

- An open note's overflow menu offers: **Copy file path** (full filesystem path to
  clipboard), **Move to folder**, **Delete note**. → NotesShell.svelte note menu
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
  notes permanently; there is no trash in the native note-delete UI flow.
  Sync is unaffected either way — the file
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
- **A new note opens with the caret in the body and the keyboard up**, both on a
  warm editor and on the first note after a cold launch. The focus is
  native first, then the page: the web view takes first responder (iOS) or
  view focus (Android), and only then does the script focus the editor.
  Chromium holds back a script focus while the document is unfocused, and from
  iOS 27 WebKit does not report one to the app at all, which is where the
  keyboard-forcing swizzle hooks in. So the page half alone gives a focused page
  with no keyboard. Also on iOS: the focus waits until the editor screen is in
  the window (a new note attaches while its screen is still being built), and
  the "force keyboard" gate stays open until the focus script has actually run
  rather than for a fixed 0.6 s. Verified on the iOS 27.0 and 26.5 simulators
  and on an iPhone (iOS 27.0) 2026-09-23. On Android it holds warm and on a cold
  launch whose FAB tap attached the note before the editor had initialized, so
  focus came through the `initialized` reply rather than `attach`; verified on
  the emulator (API 36, System WebView 133.0.6943.137) 2026-09-23. Desktop has
  no keyboard to raise; its New note puts the caret in the body, not the title,
  so typing goes straight into the note (verified on macOS 2026-09-23). →
  EditorWebView.swift `EditorHost.startAutoFocus` /
  `runPendingAutoFocus`, EditorWebView.kt `EditorHost.focusEditor`,
  src/features/notes/createNoteLoader.ts `finishNewNote`
- **Both native shells have an inline, tappable title field** above the editor
  body (iOS via a `UITextField`-backed `TitleTextField`, Android via a
  `BasicTextField`); tapping it edits the title in place and renames the file,
  debounced (500 ms). Tapping a title that is still the auto-assigned
  placeholder — "Untitled" or a dedup "Untitled-N" — **selects the whole title**
  so the next keystroke replaces it; tapping any other title places the caret at
  the tapped character. iOS also keeps a ⋯ → Rename alert as a secondary path. →
  NoteEditorView.swift `TitleTextField` / `isPlaceholderTitle`,
  NoteEditorScreen.kt `isPlaceholderTitle`
- **Return in the title moves on into the body**: the title commits, the caret
  goes to the note body, and on a phone the keyboard stays up, so typing
  continues straight into the note. The title never takes a newline. On iOS,
  Return resigns the title field and runs the same native-then-page focus a new
  note uses; on desktop, Enter focuses the editor. On Android the keyboard's
  action key reads "next", and it and a hardware Enter both run
  `EditorHost.focusEditor`, the new-note focus; the keyboard never hides on
  the way into the body. The pending rename still commits on its own debounce.
  Verified on the iOS 27.0 and 26.5 simulators and on an iPhone (iOS 27.0)
  2026-09-23, on desktop (macOS) 2026-09-23, and on the Android emulator (API
  36, System WebView 133.0.6943.137) 2026-09-23. → NoteEditorView.swift
  `TitleTextField`
  `textFieldShouldReturn`, EditorWebView.swift `EditorHost.focusBody`,
  src/features/notes/createNoteTitleController.svelte.ts, NoteTitleField.kt,
  NoteTitleFieldTest.kt
- **While the title field is focused, only typing changes it.** A title the app
  commits meanwhile — a rename that trimmed or suffixed what was typed ("jkl "
  saves as `jkl.md`, "con" as `con_.md`), a move, a sync rename, a conflict
  copy — shows once the field loses focus; typing before then discards it. A
  rewrite mid-typing moved the caret: "abc", a pause, then "def" came out
  "defabc" (Android), and "jkl ", a pause, then "mno" came out "jklmno" (Android,
  desktop). Verified on the Android emulator (API 36) and desktop (macOS)
  2026-10-05. → NoteTitleField.kt `TitleFieldState`, TitleFieldStateTest.kt,
  src/features/notes/noteSession.svelte.ts `showCommittedTitle`,
  NoteEditorView.swift `TitleTextField.updateUIView`
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
  persistent warning and blocks the rename (*(native shells)* title input is
  capped at 200 characters instead, a paste trimmed to fit); a title that
  duplicates another note in the same folder (case-insensitively) shows "A note
  with this name already exists" and blocks the rename, never the body save; an empty title is left un-renamed. The rules + messages come from the
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
