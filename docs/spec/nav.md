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
- The editor keeps the system back button, so the leading-edge swipe is the
  native, finger-tracked interactive pop, over the full-bleed editor WebView.
  The one exception is while a block is airborne in the long-press drag: both
  pop recognisers stand down then, so moving the block sideways can't swipe the
  note away (see editor.md, "Selection").
  Hiding that button (as the editor once did, to force every exit through the
  vetoable `requestNavigation`) also disables the gesture. A system pop cannot be
  refused, so the exit commits after the fact instead: in-flight rename/move/adopt
  work drains, a pending title rename commits immediately rather than after its
  debounce, and the freshest body commits, falling back to the shell's copy when
  the editor cannot answer. A commit that fails leaves the draft retained for
  lifecycle retry. Leaving is never blocked. _(iOS)_ → NoteEditorView.swift
  `finishLeave`, docs/learnings/ios-swipe-back-over-webview.md
- Leaving the editor waits for the editor's own answer. When that wait runs out
  on an editor that is still responding — a note editable from its first chunk
  while the rest streams — the screen stays where it is rather than leaving on
  the shell's copy, which can be missing the edit; the usual pending-changes
  message is shown and pressing Back again is the way out. An editor that
  responds to nothing at all is not holding anything, and leaving it always
  works. _(iOS/Android)_ On iOS this applies to the in-editor exits (a resolved
  wikilink). System Back and the edge swipe cannot stay, so they retry the capture
  and then commit the shell's copy. _(iOS)_
  → docs/spec/editor.md "Editor exits — every way an open note ends"
- Creating a note pushes the editor focused for immediate typing (Android
  focuses the native title field; desktop and iOS focus the editor body/heading);
  opening an existing note pushes it without autofocus. → AppNavigation.kt /
  NoteEditorScreen.kt, noteSession.svelte.ts `loadNote('new')`, NoteListView.swift
  The shared editor never focuses itself on mount, on any surface — the
  pre-warmed native WebView stays unfocused until the host asks (bridge
  `focus`), and desktop focus comes from the shell's own new-note path. →
  src/features/editor/milkdown/hostHandle.ts `focus`,
  noteSession.svelte.ts `focusEditor`
  iOS autofocus is confirmed on the simulator in both directions: opening an
  EXISTING note stays keyboard-less (2026-07-13 — no editor accessory toolbar
  appears on open; it only appears after tapping the body), and creating a NEW
  note raises the keyboard (2026-07-27 — driving "+" → "New Note" with `axe`,
  the accessory toolbar is present immediately, which only happens while a field
  is focused). _(iOS native)_
  > **Gap:** Android on-device autofocus QA (existing note keyboard-less +
  > native-title autofocus) is still pending. _(Android)_
- Following a wikilink PUSHES another editor onto the stack (it does not replace
  the current one), so System Back returns to the note you came from rather than
  to the List — a browser-like history of visited notes. See the wikilink
  navigation rule in [editor.md](editor.md). → AppNavigation.kt
  `AppNavigator.openNote`
  (push), NoteEditorView.swift `openLinkedNote`
  _(desktop)_ deliberately diverges: a wikilink opens the target in the
  **current tab** (replace, not push) — tabs, not a nav stack, are the desktop
  history model. → NotesShell.svelte `handleWikilinkOpen`
- The editor WebView is pre-warmed while the list is showing, so opening a note
  is a warm mount, not a cold renderer boot. Both native shells keep ONE shared
  pre-warmed WebView and swap content via `setContent` on open. →
  MainActivity.kt / EditorHost _(Android)_; FutoNotesApp
  `EditorHost.prewarm()` / EditorWebView `EditorHost.shared` _(iOS)_

- [Desktop shell _(desktop)_](nav/desktop-shell.md)
- [Native app icon sheet](nav/native-app-icon-sheet.md)
