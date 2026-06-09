# Navigation — Spec

How screens stack and transition. *(Native shells; the desktop Tauri app uses
the Svelte router and is not described here.)*

- Screens: **List** (root) → Editor / Search / Settings; **Settings** → Sync. →
  MainActivity.kt
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
