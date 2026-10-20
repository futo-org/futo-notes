## Feedback & crash reporting

- Action feedback uses transient toasts (**5 s** on the web surfaces, one at a time,
  auto-dismiss; a second toast replaces the first and restarts the clock so the newer
  message still gets its full read time):
  "Note deleted", "Moved to {folder}", "Folder created", "Path copied", etc. _(Tauri; Android
  native shows the same platform toasts — delete now toasts "Note deleted" from
  both the editor ⋮ menu and the list long-press)_ → shared/notifications/toastBus.svelte.ts
  (`TOAST_DURATION_MS`, guarded by "holds a message for five seconds, then clears it"),
  NoteEditorScreen.kt, NoteListScreen.kt
  - Raised from 3 s on 2026-09-02. The same slot carries the sync failure toasts, which are
    the only warning that the notes folder has gone missing, and that message names a full
    path before saying where to fix it — a capture taken 3.4 s after such a failure caught
    nothing but the ⚠ indicator (github#44 follow-up). Android keeps `Toast.LENGTH_LONG`,
    whose duration the OS owns, so the two surfaces are close but not identical.
- Android emits delete/move success feedback only after the Rust store returns
  a committed mutation. A failed action instead reports that the note remains
  in place; it never navigates away from the editor or dismisses the move
  picker as though the mutation succeeded. → `NoteMutationOutcome`,
  `shouldCompleteNoteAction`, NoteActionCompletionTest
- An uncaught error/crash is queued; the **next launch** shows a Crash Report
  dialog: expandable "View report", an optional "What were you doing?" field,
  a **"Send crashes automatically"** checkbox, and Send / Don't Send. Enabling
  it (also available as a Settings toggle) auto-sends future reports without
  the dialog. Rust-side panics persist the same schema under `.crashlogs`
  before the next-launch scan. → CrashReportDialog.svelte, crashHandler.ts,
  `apps/tauri/src-tauri/src/panic_reporter.rs` _(Tauri)_
- A fault that repeats within a session (same type, message, and stack) is
  reported once, not once per occurrence. An uncaught NSException does not
  also file the SIGABRT that follows it _(iOS)_. → crashHandler.ts,
  CrashReporter.swift
- The native shells run the same pipeline: an uncaught-exception handler
  (Android `Thread.setDefaultUncaughtExceptionHandler`; iOS
  `NSSetUncaughtExceptionHandler` plus fatal-signal handlers with
  pre-rendered, write-only signal paths; the stack is the crashing thread's
  frames as `<image> <offset>`, each image's UUID, and any `__crash_info`
  message such as a `try!`/`fatalError` text, symbolicated against the
  per-tag `FUTO-Notes-<version>-dSYMs.zip` release package) persists a
  desktop-schema JSON report to `<vault>/.crashlogs/` on the way down; the
  next launch scans the folder in the background (never gating render) and shows the same dialog,
  honoring the Settings toggle and Always-send; Send POSTs to the crash
  collector (`/api/crashes` batch, `/api/crash` fallback; dev builds target
  the local collector) and deletes the files. Verified end-to-end on
  emulator + simulator 2026-06-09 (test crash → relaunch dialog → collector
  received the POST → files cleared). → CrashReporter.kt +
  CrashReportDialog.kt _(Android)_, CrashReporter.swift _(iOS)_
