## WS7 — Ctrl+Q quits

**Today.** `src/app/registerNotesShellShortcuts.ts:88-118` maps Ctrl (Cmd on macOS) plus
`p n , \ t w 1-9`, and Ctrl+Tab / Ctrl+PageUp / Ctrl+PageDown. No quit binding. macOS gets ⌘Q
from the application menu in `app_menu.rs`; GNOME's guidelines expect Ctrl+Q.

**Steps.**

1. Add a `quit-app` command to the registry, bound to the primary modifier plus `q` when not on
   macOS (macOS already has it natively and a second handler would double-fire). Windows gets it
   too; it is harmless there.
2. The handler must take the same path a window-close takes so pending saves flush. Find how
   close is handled today (there is no `on_window_event` in `application.rs`, so it is Tauri's
   default) and call `getCurrentWindow().close()` rather than `process.exit`, unless closing the
   last window turns out not to end the process on Linux, in which case use the process plugin
   after the close resolves.
3. `app_menu.rs` has a test that every menu id is dispatched by the frontend; a frontend-only
   command does not affect it, but run `cargo test -p futo-notes-tauri` anyway.

**Verify.** Ctrl+Q with a dirty note: the note is on disk afterward (check the dev vault file
mtime and content). Vitest alongside the existing shortcut tests. Spec: the shortcut table in
`docs/spec/nav.md` gains the line with a `(desktop, not macOS)` tag.

---
