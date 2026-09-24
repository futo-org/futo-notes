# Navigation — Spec

How screens stack and transition. Native-shell stack first; Tauri-shell
navigation below. Desktop multi-tab lives in [tabs.md](tabs.md).

- Both native shells stack the SAME folder browser: the root screen is the vault
  root folder, and tapping a folder row pushes another folder screen (see
  [list.md](list.md#folder-browsing)). There is no drawer on either.
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
  `pruneFolderRoutes`, AppNavStackTest.kt *(Android)*
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
  lifecycle retry. Leaving is never blocked. *(iOS)* → NoteEditorView.swift
  `finishLeave`, docs/learnings/ios-swipe-back-over-webview.md
- Leaving the editor waits for the editor's own answer. When that wait runs out
  on an editor that is still responding — a note editable from its first chunk
  while the rest streams — the screen stays where it is rather than leaving on
  the shell's copy, which can be missing the edit; the usual pending-changes
  message is shown and pressing Back again is the way out. An editor that
  responds to nothing at all is not holding anything, and leaving it always
  works. *(iOS/Android)* On iOS this applies to the in-editor exits (a resolved
  wikilink). System Back and the edge swipe cannot stay, so they retry the capture
  and then commit the shell's copy. *(iOS)*
  → docs/spec/editor.md "Editor exits — every way an open note ends"
- Creating a note pushes the editor focused for immediate typing (Android
  focuses the native title field; desktop and iOS focus the editor body/heading);
  opening an existing note pushes it without autofocus. → AppNavigation.kt /
  NoteEditorScreen.kt, noteSession.svelte.ts `loadNote('new')`, NoteListView.swift
  The shared editor never focuses itself on mount, on any surface — the
  pre-warmed native WebView stays unfocused until the host asks (bridge
  `focus`), and desktop focus comes from the shell's own new-note path. →
  src/features/editor/milkdown/MilkdownEditor.svelte `focus`,
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

## Desktop shell _(desktop)_

- The sidebar is persistent and resizable (drag the divider, clamped
  240–600px so the full **FUTO Notes** brand remains on one line). A
  single collapse/expand toggle lives in the full-width desktop top band (its
  leading `topband-chrome`, which mirrors the sidebar column) and flips icon +
  label by state; it is the only sidebar toggle on desktop. Width and collapsed
  state persist across sessions. → DrawerSidebar.svelte, NotesShell.svelte,
  DesktopTopBand.svelte, TabsStrip.svelte
- On macOS the native traffic lights are overlaid on our chrome
  (`titleBarStyle: Overlay`); the top band's `topband-chrome` reserves a fixed
  leading gutter (`--macos-traffic-lights-width`) for them in one place,
  independent of sidebar state — so collapsing the sidebar never exposes or
  crowds the buttons. → configureWindowChrome.ts, desktop-shell.css
- On macOS the traffic lights sit on the sidebar toggle's centre line, with even
  spacing above them and to their left. → tauri.conf.json,
  configureWindowChrome.ts
- With the sidebar collapsed the toggle carries 20px of visible air on each
  side — to the last traffic light and to the first tab. → desktop-shell.css,
  tabsStrip.css
- On Linux the undecorated window uses one header row: minimize, maximize and
  close live in the desktop top band rather than in a second title row. GNOME's
  `org.gnome.desktop.wm.preferences button-layout` decides left/right placement
  and button order, including layouts split across both sides; other desktops use the trailing
  minimize/maximize/close default. → DesktopTopBand.svelte,
  WindowControls.svelte, window_controls.rs
- Left-side Linux controls reserve their own leading gutter through
  `--linux-window-controls-width`, parallel to the macOS traffic-light gutter,
  so the sidebar toggle and tabs never overlap them. → configureWindowChrome.ts,
  desktop-shell.css
- Every empty area of the top band drags the window — the gaps around the tabs
  and the whole chrome column, traffic-light gutter included; only the buttons
  take clicks. → DesktopTopBand.svelte, TabsStrip.svelte,
  WindowControls.svelte
- The native window title is the active note title followed by "— FUTO Notes";
  Home falls back to the app name. The app name follows the selected language,
  and changing the language keeps the active note in the title. Debug builds
  retain the `FUTO Notes (Dev)` identity in both forms, so tab changes cannot
  erase the dev/prod distinction. This is the title shown by the compositor in
  Alt+Tab and overview surfaces. → TabsStrip.svelte, App.svelte,
  windowTitle.ts, tauri.dev.conf.json
- Debian and RPM packages install a hidden `futo-notes-tauri.desktop` identity
  alias matching the native Wayland app ID, so compositors resolve the FUTO
  Notes icon in Alt+Tab. The visible `FUTO Notes.desktop` launcher remains in
  place for existing taskbar pins and Markdown associations. →
  linux/futo-notes-tauri.desktop, tauri.conf.json, linux-packaging.test.mjs
- Linux packages advertise the app in the freedesktop Office category, add
  `notes` / `markdown` search keywords, and register `text/markdown` for `.md`
  and `.markdown`, so file managers offer FUTO Notes under **Open With**. Tauri's
  `Productivity` bundle category is the source value that emits `Office` in the
  desktop entry. → tauri.conf.json, linux/futo-notes.desktop.hbs
- The window is not shown until the shell has painted: it is created hidden and
  revealed on first render, so launching never flashes the webview's white.
  Rust reveals it regardless after a timeout, so a frontend that never paints
  delays the window rather than losing it. → window_reveal.rs, App.svelte
- Window size, position, maximized and fullscreen state persist across launches,
  validated against the attached monitors so an unplugged display cannot strand
  the window off-screen. → application.rs (tauri-plugin-window-state)
- The window's own appearance follows the resolved app theme, so the OS draws the
  window frame, the application menu and native dialogs in the app's light/dark
  rather than the system's. On macOS the visible tell is the stroke AppKit
  composites along the window's top edge: white@55% over our dark top band when
  the window is light (a bright hairline on a dark desktop) against white@20%
  when it is dark. On Windows it is the titlebar. On Linux the window carries no
  native frame at all (decorations are off and the app draws its own header
  controls), so it reaches only GTK-drawn surfaces such as the WebKitGTK context
  menu; file choosers are portal-owned and follow the desktop. → theme.ts
  `windowAppearanceFor`, windowAppearance.ts
- On **auto** the window is handed back to the OS on macOS and Windows and pinned
  to the resolved theme on Linux. Same outcome, opposite mechanism, because the
  platforms disagree about what "no preference" means: on macOS and Windows
  pinning a theme stops the platform reporting later system light/dark switches,
  while GTK has no such value — tao maps both "none" and "light" onto
  `gtk-application-prefer-dark-theme = false`, which WebKitGTK also reads as the
  page's own `prefers-color-scheme`, so handing the window back would make a dark
  Linux desktop render light. → theme.ts `windowAppearanceFor`,
  desktop_settings.rs (`linux-theme-changed`)
- On **auto** the resolved theme comes from the system's own answer, which is a
  different signal per platform. macOS and Windows read the page's
  `prefers-color-scheme`: their `auto` hands the window back to the OS, so they
  never write the value they read. Linux reads the xdg desktop portal's
  `org.freedesktop.appearance` / `color-scheme`, because pinning makes the page's
  media query an echo of the app's own last choice — so on a dark desktop,
  choosing **Light** and then **Auto** renders dark, and it does so immediately
  rather than only after a relaunch. Linux falls back to the reported change and
  then to the media query only when no portal answers. → theme.ts
  `resolveAutoTheme`, platform_integration.rs `read_desktop_color_scheme`
- One desktop light/dark change can arrive alongside unrelated portal signals
  on the same `SettingChanged` stream, and only an exact
  `org.freedesktop.appearance` / `color-scheme` namespace+key match re-resolves
  the theme — settings that merely look like a theme change, such as KDE's
  `ColorScheme` scheme *name* signal (a different key entirely), are ignored.
  Overlapping theme applies are serialized so the newest request wins, never
  whichever resolved last. → desktop_settings.rs (`read_snapshot`, filtered by
  exact namespace/key rather than string matching), theme.ts
  `applyThemePreference`
  <!-- NOTE (rebase judgment call, flagged for review): this paragraph
  originally documented platform_integration.rs's `desktop_theme_from_setting_changed`,
  a gdbus-output string parser main hardened independently. !277 replaces that
  whole mechanism with desktop_settings.rs's typed zbus reads, which the rebase
  resolution kept (see .rebase-log.md); the burst-signal guarantee still holds,
  just via a different, more robust implementation, so the reference was
  updated rather than left dangling. The desktop accent-following feature
  (which desktop_settings.rs's watcher also carried) was itself reverted by
  !277's own last commit (d916ee15) after review, so the snapshot now only
  ever carries theme. -->
- Linux reads the portal's current colour scheme before relying on later change
  signals, so switching Light/Dark back to Auto immediately resolves from the
  desktop rather than from WebKitGTK's app-pinned media query. Older portals
  fall back from `ReadOne` to `Read`. → desktop_settings.rs, theme.ts
- Opening an `.md` already inside the active vault opens that safe note id in a
  tab. Opening an outside `.md` or `.markdown` asks whether to copy it into the
  vault; **Cancel** leaves it untouched, while **Copy into notes** uses the atomic Rust store
  workflow, preserves the filename as the title, collision-suffixes rather than
  overwriting, and opens the final id. Cold-launch arguments and later
  single-instance launches share this policy. → external_file_open.rs,
  externalFileOpen.ts, `LocalNoteStore::import_markdown`

### Application menu _(macOS)_

- macOS gets a real menu bar owned by the app: **App** (About, Settings… ⌘,
  Services, Hide, Quit) · **File** (New Note ⌘N, New Tab ⌘T, Reopen Closed Tab
  ⇧⌘T, Search Notes… ⌘P, Close Tab ⌘W, Close Window ⇧⌘W) · **Edit** (undo, redo,
  cut, copy, paste, select all) · **View** (Toggle Sidebar ⌘\, Full Screen) ·
  **Window**. → app_menu.rs
- ⌘W closes the **tab**; ⇧⌘W closes the window. macOS resolves a menu item's key
  equivalent before the webview sees it, so the menu — not the keydown handler —
  is what makes ⌘W reach the tab strip at all. → app_menu.rs, tabs.md
- A menu command and its keyboard accelerator run the same shell command; the
  menu's command ids are locked against the shell's dispatch table by a test. →
  registerNotesShellShortcuts.ts, app_menu.rs
- Windows and Linux render no menu bar; their accelerators stay with the
  keydown handler. → app_menu.rs

### Desktop chrome behaves like an application, not a document _(desktop)_

- Chrome shows the arrow cursor — rows, tabs, buttons and toolbar icons never
  switch to the pointing hand, and pressing or dragging a row never shows the
  grabbing hand. Text fields keep the I-beam, the sidebar divider keeps the
  resize cursor, outbound links keep the pointer, and the editor keeps every
  document cursor it had. → desktop-native.css
- Right-clicking chrome opens nothing. Right-clicking inside the editor, inside
  a text field, or on a live selection still opens the native menu — Cut/Copy/
  Paste, Look Up, Share and spellcheck suggestions. The app's own note and
  folder context menus are unaffected. → installDesktopContextMenuGuard.ts
- _(macOS)_ Opening a context menu never also activates what is under it: a
  control-click, which WebKit reports as a `click` (and a second one as a
  `dblclick`) alongside the `contextmenu`, leaves the note unopened, the
  folder's expansion unchanged, and no inline rename open. Off macOS the
  secondary button produces no `click` at all and Ctrl+click stays the
  open-in-background-tab modifier. → installDesktopContextMenuGuard.ts
- Settings opens with ⌘, and the sidebar toggles with ⌘\ (Ctrl elsewhere). →
  registerNotesShellShortcuts.ts
- Ctrl+Q closes the app window on Linux and Windows through the normal close
  path, which flushes a pending note save before exit; macOS keeps its native
  ⌘Q application-menu command. → registerNotesShellShortcuts.ts,
  startNativeShell.ts
- The system "Reduce Motion" setting removes the shell's transitions and
  animations. → desktop-native.css
