# Navigation — Spec

How screens stack and transition. Native-shell stack first; Tauri-shell
navigation below. Desktop multi-tab lives in [tabs.md](tabs.md).

- Screens: **List** (root) → Editor / Search / Settings; **Settings** → Sync. →
  MainActivity.kt *(Android)*
- iOS native: **List** (root) → Editor / folder screen (tapping a folder row
  pushes a filtered list titled with the folder name); search is an inline
  bottom search bar on the list; the nav-bar gear presents the Settings
  sheet and the cloud button presents the Sync sheet (see settings.md). →
  NoteListView.swift *(iOS)*
  > **Gap:** *(accessibility — fix did not take effect at runtime)* The iOS
  > list nav-bar controls — the **gear** (Settings), the **cloud** (Sync), and
  > the **"+"** create-note menu — carry explicit `accessibilityLabel`s
  > ("Settings" / "Sync" / "New note or folder"), a `.isButton` trait, stable
  > `accessibilityIdentifier`s (`nav-settings` / `nav-sync` / `nav-create`),
  > and distinct `ToolbarItem(id:)`s in code (added 2026-06-26), but the
  > runtime check the gap was waiting on **failed**: an `idb ui describe-all`
  > pass on the iOS 26.5 simulator (2026-07-02, during a QA run) shows the
  > list nav-bar controls as **unlabeled Groups** — no labels, identifiers, or
  > button traits surface in the AX tree, and automation must tap them by
  > screenshot coordinates. (The editor's nav bar is fine — its "…" exposes
  > AXLabel "More".) Needs investigation into why SwiftUI toolbar-hosted
  > labels don't reach the AX tree here. → NoteListView.swift toolbar
- A typed nav stack holds entries. Note ids and folders contain `/`, which would
  break string-based routes, so the stack holds typed `Screen` values, not path
  strings. → MainActivity.kt
- System Back pops one screen. Back on the root List does nothing app-side (the
  stack floor is the List — the app never intercepts it there); on Android the
  unhandled Back then follows the OS default and backgrounds/finishes the
  activity. "Nothing app-side" means the nav stack never changes, not that the
  event is swallowed. → MainActivity.kt `BackHandler(enabled = stack.size > 1)`
- Forward transitions slide in + fade; back transitions fade + slide out.
  *(Android)*
- Creating a note pushes the editor focused for immediate typing (Android
  focuses the native title field; desktop and iOS focus the editor body/heading);
  opening an existing note pushes it without autofocus. → MainActivity.kt /
  NoteEditorScreen.kt, noteSession.svelte.ts `loadNote('new')`, NoteListView.swift
  The shared editor's mount-time auto-focus is gated off the native embeds
  (`if (!nativeShell)`, 2026-07-09) — the pre-warmed native WebView no longer
  focuses itself; it stays unfocused until the host asks (bridge `focus`, the
  new-note autofocus path). → MarkdownEditor.svelte mount auto-focus
  > **Gap:** on-device autofocus QA is partly done. iOS: opening an EXISTING
  > note stays keyboard-less — verified on the simulator 2026-07-13 (no editor
  > accessory toolbar appears on open; it only appears after tapping the body).
  > iOS new-note autofocus (editor body raises the keyboard) is
  > inspection-confirmed only — the nav-bar "New Note" menu is not idb-drivable
  > on iOS 26 (M21), so it wasn't exercised. Android (existing keyboard-less +
  > native-title autofocus) is still pending. *(native shells)*
- Following a wikilink PUSHES another editor onto the stack (it does not replace
  the current one), so System Back returns to the note you came from rather than
  to the List — a browser-like history of visited notes. See the wikilink
  navigation rule in [editor.md](editor.md). → MainActivity.kt `onOpenNote`
  (push), NoteEditorView.swift `openLinkedNote`
- The editor WebView is pre-warmed while the list is showing, so opening a note
  is a warm mount, not a cold renderer boot. Both native shells keep ONE shared
  pre-warmed WebView and swap content via `setContent` on open. →
  MainActivity.kt / EditorHost *(Android)*; FutoNotesApp
  `EditorHost.prewarm()` / EditorWebView `EditorHost.shared` *(iOS)*

## Desktop shell *(desktop)*

- The sidebar is persistent and resizable (drag the divider, min 200px). A
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
