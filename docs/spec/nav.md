# Navigation — Spec

How screens stack and transition. Native-shell stack first; Tauri-shell
navigation below. Desktop multi-tab lives in [tabs.md](tabs.md).

- Screens: **List** (root) → Editor / Search / Settings; **Settings** → Sync. →
  AppNavigation.kt *(Android)*
- iOS native: **List** (root) → Editor / folder screen (tapping a folder row
  pushes a filtered list titled with the folder name); search is an inline
  bottom search bar on the list; the nav-bar gear presents the Settings
  sheet and the cloud button presents the Sync sheet (see settings.md). →
  NoteListView.swift *(iOS)*
  The list nav-bar controls are exposed to accessibility and to automation: the
  **gear** (Settings), **cloud** (Sync), and **"+"** create-note menu each carry
  an `accessibilityLabel` ("Settings" / "Sync" / "New note or folder"), a stable
  `accessibilityIdentifier` (`nav-settings` / `nav-sync` / `nav-create`), and a
  distinct `ToolbarItem(id:)`. Confirmed at runtime on the iOS 26.5 simulator
  2026-07-27: `axe describe-ui` reports each as a `Button` carrying both its
  label and its identifier, `axe tap --id nav-settings --element-type Button`
  opens the Settings sheet, and `--id nav-create` opens the create menu whose
  "New Note" item is itself tappable. Every nav item also appears as a wrapping
  `Group`, so automation must pass `--element-type`. → NoteListView.swift
  toolbar
- A typed nav stack holds entries. Note ids and folders contain `/`, which would
  break string-based routes, so the stack holds typed `Screen` values, not path
  strings. → AppNavigation.kt
- System Back pops one screen. Back on the root List does nothing app-side (the
  stack floor is the List — the app never intercepts it there); on Android the
  unhandled Back then follows the OS default and backgrounds/finishes the
  activity. "Nothing app-side" means the nav stack never changes, not that the
  event is swallowed. → AppNavigation.kt `BackHandler`
- Forward transitions slide in + fade; back transitions fade + slide out.
  → AppNavigation.kt *(Android)*
- Activity recreation starts a fresh route stack at List while restoring the
  list's selected folder and scroll position. → AppNavigation.kt /
  AppNavigationTest.kt *(Android)*
- A swipe from the editor's leading edge goes back, running the SAME gated exit as
  the Back button (`requestNavigation`): it drains in-flight rename/move/adopt work
  and will not leave while a rename cannot commit. Because the editor hides the
  system back button to force every exit through that verb, UIKit's interactive pop
  gesture is disabled, so this swipe — not the system gesture — IS back-by-swipe on
  the editor screen. Verified on the iOS 26.5 simulator and a physical iPhone 17
  Pro, 2026-07-27. *(iOS)* → EditorEdgeSwipeBack.swift, NoteEditorView.swift
  `requestNavigation`
- The editor's back-swipe is owned by a 20pt strip on the leading edge, which
  consumes every touch in that column: a drag started there does not scroll the
  note, and a tap there does not place the caret. The strip is sized to the
  editor's own text inset so it covers margin rather than tappable text. The pop is
  animated, not finger-tracked. Both are consequences of keeping the exit vetoable
  — an interactive pop cannot be refused once the finger starts it — and the
  alternative is tracked in issue #69. *(iOS)*
  → docs/learnings/ios-swipe-back-over-webview.md
- Creating a note pushes the editor focused for immediate typing (Android
  focuses the native title field; desktop and iOS focus the editor body/heading);
  opening an existing note pushes it without autofocus. → AppNavigation.kt /
  NoteEditorScreen.kt, noteSession.svelte.ts `loadNote('new')`, NoteListView.swift
  The shared editor's mount-time auto-focus is gated off the native embeds
  (`if (!nativeShell)`, 2026-07-09) — the pre-warmed native WebView no longer
  focuses itself; it stays unfocused until the host asks (bridge `focus`, the
  new-note autofocus path). → MarkdownEditor.svelte mount auto-focus
  iOS autofocus is confirmed on the simulator in both directions: opening an
  EXISTING note stays keyboard-less (2026-07-13 — no editor accessory toolbar
  appears on open; it only appears after tapping the body), and creating a NEW
  note raises the keyboard (2026-07-27 — driving "+" → "New Note" with `axe`,
  the accessory toolbar is present immediately, which only happens while a field
  is focused). *(iOS native)*
  > **Gap:** Android on-device autofocus QA (existing note keyboard-less +
  > native-title autofocus) is still pending. *(Android)*
- Following a wikilink PUSHES another editor onto the stack (it does not replace
  the current one), so System Back returns to the note you came from rather than
  to the List — a browser-like history of visited notes. See the wikilink
  navigation rule in [editor.md](editor.md). → AppNavigation.kt
  `AppNavigator.openNote`
  (push), NoteEditorView.swift `openLinkedNote`
  *(desktop)* deliberately diverges: a wikilink opens the target in the
  **current tab** (replace, not push) — tabs, not a nav stack, are the desktop
  history model. → NotesShell.svelte `handleWikilinkOpen`
- The editor WebView is pre-warmed while the list is showing, so opening a note
  is a warm mount, not a cold renderer boot. Both native shells keep ONE shared
  pre-warmed WebView and swap content via `setContent` on open. →
  MainActivity.kt / EditorHost *(Android)*; FutoNotesApp
  `EditorHost.prewarm()` / EditorWebView `EditorHost.shared` *(iOS)*

## Desktop shell *(desktop)*

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
- On Linux the app renders its own 36px title bar ("FUTO Notes" +
  minimize/maximize/close) above the top band; macOS and Windows use native
  window chrome instead. → configureWindowChrome.ts, TitleBar.svelte
- Every empty area of the top band drags the window — the gaps around the tabs
  and the whole chrome column, traffic-light gutter included; only the buttons
  take clicks. Same on the Linux title bar. → DesktopTopBand.svelte,
  TabsStrip.svelte, TitleBar.svelte
- The window is not shown until the shell has painted: it is created hidden and
  revealed on first render, so launching never flashes the webview's white.
  Rust reveals it regardless after a timeout, so a frontend that never paints
  delays the window rather than losing it. → window_reveal.rs, App.svelte
- Window size, position, maximized and fullscreen state persist across launches,
  validated against the attached monitors so an unplugged display cannot strand
  the window off-screen. → application.rs (tauri-plugin-window-state)

### Application menu *(macOS)*

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

### Desktop chrome behaves like an application, not a document *(desktop)*

- Chrome shows the arrow cursor — rows, tabs, buttons and toolbar icons never
  switch to the pointing hand. Text fields keep the I-beam, the sidebar divider
  keeps the resize cursor, outbound links keep the pointer, and the editor keeps
  every document cursor it had. → desktop-native.css
- Right-clicking chrome opens nothing. Right-clicking inside the editor, inside
  a text field, or on a live selection still opens the native menu — Cut/Copy/
  Paste, Look Up, Share and spellcheck suggestions. The app's own note and
  folder context menus are unaffected. → installDesktopContextMenuGuard.ts
- Settings opens with ⌘, and the sidebar toggles with ⌘\ (Ctrl elsewhere). →
  registerNotesShellShortcuts.ts
- The system "Reduce Motion" setting removes the shell's transitions and
  animations. → desktop-native.css
