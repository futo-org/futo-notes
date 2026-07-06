# Tabs — Spec *(desktop)*

Multi-tab is a desktop-Tauri surface; the mobile Tauri shell and the native
shells are single-document. → TabsStrip.svelte, tabsStore.svelte.ts

## Tabs

- Multiple notes can be open in tabs; the strip shows each note's title
  (truncated with ellipsis). Clicking a tab activates it.
- A "+" button (or Ctrl/Cmd+T) opens a new Home tab; a tab with no note shows
  the For You home and can be reused.
- Middle-click or Ctrl/Cmd+W closes a tab; Ctrl/Cmd+Shift+T reopens the last
  closed tab.
- Tabs drag to reorder, with an insertion-slot indicator.
- Open tabs, their order, per-tab scroll position, and the active tab persist
  across restarts.
- Opening a note from the sidebar replaces the current tab's note.
  Ctrl/Cmd+click, Shift+click, or middle-click opens it in a new **background**
  tab (the current tab stays active); Ctrl/Cmd+Shift+click opens it in a new
  **foreground** tab. → tabsStore.svelte.ts `modeFromEvent`
  (regression-locked by tabsStore.test.ts)

## Keyboard shortcuts

- Ctrl/Cmd+P — search popup; Ctrl/Cmd+N — new note. *(also mobile-keyboard
  capable platforms)* → NotesShell.svelte
- Ctrl+Tab / Ctrl+Shift+Tab — next/previous tab (Ctrl+PageDown / Ctrl+PageUp
  as fallback; Cmd+Alt+Right/Left on macOS).
- Ctrl/Cmd+1…9 — jump to tab N; 9 always jumps to the last tab.
- Editor: Ctrl/Cmd+B bold, Ctrl/Cmd+I italic, Ctrl/Cmd+Shift+S strikethrough,
  CM6 history undo/redo, Tab/Shift+Tab indent/dedent in lists. →
  markdownToolbar.ts, listContinuation.ts
