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
- A typed nav stack holds entries. Note ids and folders contain `/`, which would
  break string-based routes, so the stack holds typed `Screen` values, not path
  strings. → MainActivity.kt
- System Back pops one screen. Back on the root List does nothing app-side (the
  stack floor is the List). → MainActivity.kt
- Forward transitions slide in + fade; back transitions fade + slide out.
  *(Android)*
- Creating a note pushes the editor with the title autofocused; opening an
  existing note pushes it without autofocus. → MainActivity.kt
- The editor WebView is pre-warmed while the list is showing, so opening a note
  is a warm mount, not a cold renderer boot. Both native shells keep ONE shared
  pre-warmed WebView and swap content via `setContent` on open. →
  MainActivity.kt / EditorHost *(Android)*; FutoNotesApp
  `EditorHost.prewarm()` / EditorWebView `EditorHost.shared` *(iOS)*

## Desktop shell *(desktop)*

- The sidebar is persistent and resizable (drag the divider, min 200px); a
  collapse toggle hides it to an expand button in the desktop tab strip's
  leading slot. Width and collapsed state persist across sessions. →
  DrawerSidebar.svelte, NotesShell.svelte, TabsStrip.svelte
