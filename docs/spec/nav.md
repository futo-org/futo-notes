# Navigation — Spec

How screens stack and transition. Native-shell stack first; Tauri-shell
navigation below. Desktop multi-tab lives in [tabs.md](tabs.md).

- Both native shells stack the SAME folder browser: the root screen is the vault
  root folder, and tapping a folder row pushes another folder screen (see
  [list.md](list/folder-browsing.md#folder-browsing)). There is no drawer on either.
- Screens: **Folder** (root = the vault root, the stack floor) → Folder /
  Editor / Search / Settings; **Settings** → Sync / Storage location. A folder
  screen can push another folder screen to any depth. → AppNavigation.kt
  _(Android)_
- iOS native: `Route` { folder / note / newNote } on one `NavigationStack`;
  search is an inline bottom search bar on the list, which bypasses the folder
  browser for a flat cross-folder result list; the nav-bar gear presents the
  Settings sheet and the cloud button presents the Sync sheet (see settings.md).
  → NoteListView.swift _(iOS)_
  The list nav-bar controls are exposed to accessibility and to automation: the
  **gear** (Settings), **cloud** (Sync), **folder-badge-plus** (New folder), and
  **compose** (New note) buttons each carry an `accessibilityLabel` ("Settings" /
  "Sync" / "New folder" / "New note"), a stable `accessibilityIdentifier`
  (`nav-settings` / `nav-sync` / `nav-create-folder` / `nav-create`), and a
  distinct `ToolbarItem(id:)`. Confirmed at runtime on the iOS 26.5 simulator
  2026-07-27: `axe describe-ui` reports each as a `Button` carrying both its
  label and its identifier, `axe tap --id nav-settings --element-type Button`
  opens the Settings sheet, and `--id nav-create` creates and opens a note in
  one tap (it was a New Note / New Folder menu until 2026-09-02, github#5).
  Every nav item also appears as a wrapping `Group`, so automation must pass
  `--element-type`. → NoteListView.swift toolbar
- A typed nav stack holds entries. Note ids and folder paths contain `/`, which
  would break string-based routes, so the stack holds typed `Screen` values
  (`Screen.Folder(path)`, `Screen.Editor(noteId, …)`), not path strings. →
  AppNavigation.kt
- System Back pops one screen — including one folder level, which is also what
  the folder screen's top-bar up arrow does. Back on the root folder does nothing
  app-side (it is the stack floor — the app never intercepts it there); on
  Android the unhandled Back then follows the OS default and
  backgrounds/finishes the activity. "Nothing app-side" means the nav stack never
  changes, not that the event is swallowed. → AppNavigation.kt `BackHandler`
- Every full-screen surface the shell can reach is a stack entry, so Back always
  has an owner. Settings → **Storage location** is one: Back and its **Cancel**
  button are the same pop, both landing on Settings. (The first-run picker draws
  the same composable, but it is a different surface — shown before a vault
  exists, with no stack behind it and no Cancel, so Back there leaves the app.)
  Presented as an overlay instead, Storage location left Back operating on the
  Settings entry it was covering: the first press popped Settings invisibly and
  the second finished the activity (github#28, reproduced and fixed on an API 34
  emulator 2026-08-18). _(Android)_ → AppNavigation.kt `Screen.StorageLocation`,
  MainActivity.kt `AppShell`
- A blocking progress overlay ("Moving notes…", "Deleting all notes…") swallows
  Back as well as taps, so neither operation can be left part-way by a Back press
  the shell underneath would have handled. _(Android)_ → MainActivity.kt,
  SettingsScreen.kt
- Forward transitions slide in + fade; back transitions fade + slide out.
  Direction is derived from stack **depth**, not screen type, so a
  folder→folder push and its pop animate opposite ways. → AppNavigation.kt
  _(Android)_
- Activity recreation starts a fresh route stack at the **vault root folder**,
  restoring the root list's scroll position; a deeper folder stack is
  deliberately not restored, so the user always returns to a screen that is
  guaranteed to exist. → AppNavigation.kt / NoteListState.kt /
  AppNavigationTest.kt _(Android)_
- A folder route whose folder is renamed or moved rebases onto the new path; a
  folder route whose folder stops existing is dropped, popping to the nearest
  surviving ancestor. → AppNavigation.kt `rebaseFolderRoutes` /
  `pruneFolderRoutes`, AppNavStackTest.kt _(Android)_
- *(iOS)* The editor keeps the system Back button and native leading-edge interactive pop. System Back and edge swipe may leave before persistence completes; the leave owner drains admitted title/action work, commits a pending title and saves the Rust session. A failed save keeps the attachment for retry or for reopening the same draft. → apps/ios/Sources/Editor/TextFirst/{TextFirstNoteScreen,TextFirstLeaves}.swift
- *(Android)* Ordinary editor navigation completes the native close workflow before changing screens. Failure keeps the editor and save error available; retry or an explicit discard can settle the departure. A partially opened long note applies queued input before saving. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt, [native exits](editor/editor-exits.md)
- Creating a note pushes the editor with the body focused for immediate typing; opening an existing note pushes it without autofocus. Native views receive focus from their new-note path, and desktop focus comes from its shell rather than editor mount. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt, apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, src/features/notes/createNoteLoader.ts
  > **Gap:** Android on-device autofocus QA (existing note keyboard-less + new-note autofocus) is still pending. _(Android)_
- Following a wikilink PUSHES another editor onto the stack (it does not replace
  the current one), so System Back returns to the note you came from rather than
  to the List — a browser-like history of visited notes. See the wikilink
  navigation rule in [editor.md](editor.md). → AppNavigation.kt
  `AppNavigator.openNote`
  (push), apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift `onOpenNote`
  _(desktop)_ deliberately diverges: a wikilink opens the target in the
  **current tab** (replace, not push) — tabs, not a nav stack, are the desktop
  history model. → NotesShell.svelte `handleWikilinkOpen`
- *(mobile)* The shell renders immediately and opens each note through its Rust session and native renderer. Long notes may show a read-only first screen while the attachment opens; queued input is applied before the complete view becomes editable. → [native boot](editor/native-host-boot.md), [long notes](editor/mobile/long-notes.md)

- [Desktop shell _(desktop)_](nav/desktop-shell.md)
- [Native app icon sheet](nav/native-app-icon-sheet.md)
