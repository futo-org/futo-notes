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
  The iOS list nav-bar controls — the **gear** (Settings), the **cloud**
  (Sync), and the **"+"** create-note menu — are each a separate, labeled,
  activatable accessibility element (they do NOT collapse into one unlabeled
  container). Each carries an explicit `accessibilityLabel` ("Settings" /
  "Sync" / "New note or folder"), a button trait, and a stable
  `accessibilityIdentifier` (`nav-settings` / `nav-sync` / `nav-create`); the
  two leading items have distinct `ToolbarItem(id:)`s. Runtime-confirmed on the
  iOS 26.5 simulator via `idb ui describe-point` 2026-07-01: gear →
  `{AXLabel:"Settings", id:nav-settings, AXButton}`, cloud →
  `{AXLabel:"Sync", id:nav-sync, AXButton}`, "+" → `{AXLabel:"New note or
  folder", id:nav-create, AXPopUpButton}`, all `enabled`. → NoteListView.swift
  toolbar
- A typed nav stack holds entries. Note ids and folders contain `/`, which would
  break string-based routes, so the stack holds typed `Screen` values, not path
  strings. → MainActivity.kt
- System Back pops one screen. Back on the root List does nothing app-side (the
  stack floor is the List). → MainActivity.kt
- Forward transitions slide in + fade; back transitions fade + slide out.
  *(Android)*
- Creating a note pushes the editor focused for immediate typing (Android
  focuses the native title field; desktop and iOS focus the editor body/heading);
  opening an existing note pushes it without autofocus. → MainActivity.kt /
  NoteEditorScreen.kt, noteSession.svelte.ts `loadNote('new')`, NoteListView.swift
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
