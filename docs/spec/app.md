# App — Cross-Cutting Spec

Behaviors and constraints that hold across every surface and platform.

## Render lifecycle

- The UI shell renders immediately. **Never gate first render on filesystem
  I/O.** Theme, prefs, notes, and the search index load in the background and
  apply reactively. → CLAUDE.md "Key Constraints"; `App.svelte` flips
  `initialized` synchronously.
- iOS `plugin-fs` reads (`readTextFile`, `exists`) can hang indefinitely on a
  cold sandbox — never `await` one before first render. *(iOS / desktop Tauri)*

## Notes & files

- **The filename IS the title.** `"grocery list.md"` → title `"grocery list"`.
  No case changes, no dash→space, no transformations; only filesystem-breaking
  characters are stripped. → `sanitizeTitle`
- Notes are plain Markdown files on disk — "file over app." A note's content is
  its file's bytes; renaming a note renames its file.

## Where logic lives

- Note CRUD, rules, sync, search, and indexing logic live in Rust
  (`crates/futo-notes-*`), exposed **once** via the `futo-notes-ffi` UniFFI
  facade (iOS/Android) and `#[tauri::command]`s (desktop). Svelte / Compose /
  SwiftUI are thin shells that call in and render. →
  docs/migration/rust-core-migration-plan.md
- Deterministic editor rules (filename/tag parsing) may keep a synchronous TS
  copy in `packages/editor` to avoid a per-keystroke IPC/FFI hop, but it is
  conformance-locked bit-for-bit against the Rust impl. → tests/conformance

## Performance

- Book-length notes must stay responsive. No synchronous full-document parse on
  the open path (`ensureSyntaxTree(..., doc.length, 5000)` is banned there) —
  build decorations from the current tree and grow incrementally. →
  docs/learnings/scroll-fix-handoff-report.md

## Data safety

- Dev/debug builds must never overwrite the production app or notes: a distinct
  bundle id (`com.futo.notes.dev`) and a distinct notes root
  (`~/Documents/fake-notes` on desktop). → CLAUDE.md

## Dialogs *(desktop)*

- `window.confirm()` / `window.alert()` don't block in Tauri's webview — use
  `ask()` / `message()` from `@tauri-apps/plugin-dialog`. → CLAUDE.md

## Feedback & crash reporting

- Action feedback uses transient toasts (~3 s, one at a time, auto-dismiss):
  "Note deleted", "Moved to {folder}", "Path copied", etc. *(Tauri; Android
  native uses platform toasts for the same moments)* → toast.ts
- An uncaught error/crash is queued; the **next launch** shows a Crash Report
  dialog: expandable "View report", an optional "What were you doing?" field,
  an "Always send crash reports" checkbox, and Send / Don't Send. "Always
  send" (also a Settings toggle) auto-sends future reports without the
  dialog. Verified on Android Tauri 2026-06-09. → CrashReportDialog.svelte,
  crashHandler.ts *(Tauri)*
- The native shells run the same pipeline: an uncaught-exception handler
  (Android `Thread.setDefaultUncaughtExceptionHandler`; iOS
  `NSSetUncaughtExceptionHandler` plus fatal-signal handlers with
  pre-rendered, write-only signal paths) persists a desktop-schema JSON
  report to `<vault>/.crashlogs/` on the way down; the next launch scans the
  folder in the background (never gating render) and shows the same dialog,
  honoring the Settings toggle and Always-send; Send POSTs to the crash
  collector (`/api/crashes` batch, `/api/crash` fallback; dev builds target
  the local collector) and deletes the files. Verified end-to-end on
  emulator + simulator 2026-06-09 (test crash → relaunch dialog → collector
  received the POST → files cleared). → CrashReporter.kt +
  CrashReportDialog.kt *(Android)*, CrashReporter.swift *(iOS)*
