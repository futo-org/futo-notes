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
- A note may embed images (`![](image-…)`); those image files are first-class
  vault content, not just notes. Anything that walks "the vault" for sync or
  integrity must include image blobs, not only `.md` — an image that a note
  references but that doesn't travel with it is a data-integrity bug (it leaves
  a broken `![]()` on every other device). → [sync.md](sync.md) "Embedded
  images sync with their notes"

## Vault location & file-manager access

- The vault should be reachable from the OS file browser so users can open, back
  up, and inter-operate with their notes ("file over app"). The Rust core does
  direct `std::fs` path I/O, so SAF / content-URIs are not viable — a
  user-visible vault must be a real filesystem path.
- **Desktop:** the vault is a normal folder (`~/Documents/futo-notes`), always
  browsable; changeable in Settings.
- **iOS:** the vault lives in the app's Documents container
  (`Documents/futo-notes`) and is exposed in the Files app under
  "On My iPhone → FUTO Notes" via `UIFileSharingEnabled` +
  `LSSupportsOpeningDocumentsInPlace`. Sync state / crash logs are dotfiles
  inside the vault, which the Files app hides. Applies to all installs (it only
  reveals the existing folder — no migration). *(iOS)*
- **Android:** two storage modes, chosen on first run (Obsidian-style picker;
  Device storage is the pre-selected recommended default), switchable later in
  Settings → Storage:
  - **Device storage** — `Documents/FUTO Notes` on shared storage: visible in
    the stock Files app + survives uninstall. Needs the "All files access"
    (`MANAGE_EXTERNAL_STORAGE`) permission, requested behind a rationale screen
    shown before the system dialog. Android 11+ only.
  - **App storage** — `Android/data/<pkg>/files/futo-notes`: no permission, but
    invisible to the stock Files app on Android 11+ and deleted on uninstall.
  Switching modes migrates the whole vault (including the `.futo` sync state) and
  relaunches; the move is transparent to sync (object map is keyed by relative
  filename → [sync.md](sync.md)).
- **No silent relocation of existing installs.** An Android install that predates
  the picker is grandfathered on its legacy internal location
  (`filesDir/futo-notes`); it gains Files-app access only by opting in via
  Settings (which migrates). An update must never repoint an existing vault out
  from under the user.
- **Dev/prod guard for Device storage:** the public Documents folder is not
  package-scoped, so debug builds use `Documents/FUTO Notes Dev` while release
  uses `Documents/FUTO Notes` (App/Internal modes already isolate via the `.dev`
  applicationId). → [Data safety](#data-safety)

> **Gap:** Android pre-11 (API < 30) devices can't use Device storage (All-files
> access is an API-30 mechanism) — they only get App storage, so their vault is
> not visible in a file manager. *(Android)*

> **Gap:** The vault folder is fixed per mode and not a user-pickable arbitrary
> directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive
> vault option. Both are possible follow-ups. *(iOS / Android)*

## Where logic lives

- Note CRUD, rules, sync, search, and indexing logic live in Rust
  (`crates/futo-notes-*`), exposed **once** via the `futo-notes-ffi` UniFFI
  facade (iOS/Android) and `#[tauri::command]`s (desktop). Svelte / Compose /
  SwiftUI are thin shells that call in and render. →
  AGENTS.md → "Where Logic Lives"
- Deterministic editor rules (filename/tag parsing) may keep a synchronous TS
  copy in `packages/editor` to avoid a per-keystroke IPC/FFI hop, but it is
  conformance-locked bit-for-bit against the Rust impl. → tests/conformance

## Performance

- Book-length notes must stay responsive. On the open path an unbounded
  synchronous full-document parse (`ensureSyntaxTree(..., doc.length, 5000)`) is
  banned; instead the `LiveMarkdownPlugin` constructor seeds decorations with a
  tightly time-boxed (≤200 ms) `ensureSyntaxTree(..., doc.length, 200)` parse,
  then grows decorations incrementally as parsing continues
  (`scheduleParseRefresh`). → src/lib/liveMarkdownTransform.ts,
  docs/learnings/scroll-fix-handoff-report.md

## Data safety

- Dev/debug builds must never overwrite the production app or notes: a distinct
  bundle id (`com.futo.notes.dev`) and a distinct notes root
  (`~/Documents/fake-notes` on desktop). → CLAUDE.md
- Production native mobile builds use the production package/bundle id
  `com.futo.notes`; native debug builds use `com.futo.notes.dev` so local
  installs keep separate app data and credentials.

## Dialogs *(desktop)*

- `window.confirm()` / `window.alert()` don't block in Tauri's webview — use
  `ask()` / `message()` from `@tauri-apps/plugin-dialog`. → CLAUDE.md
- Confirmation prompts go through `confirmDialog()` (`src/lib/confirm.ts`):
  `ask()` under Tauri, `window.confirm()` in the plain web shell (dev server,
  Playwright) where plugin-dialog has no backend and would reject. → confirm.ts

## Feedback & crash reporting

- Action feedback uses transient toasts (~3 s, one at a time, auto-dismiss):
  "Note deleted", "Moved to {folder}", "Path copied", etc. *(Tauri; Android
  native shows the same platform toasts — delete now toasts "Note deleted" from
  both the editor ⋮ menu and the list long-press)* → toast.ts,
  NoteEditorScreen.kt, NoteListScreen.kt
- An uncaught error/crash is queued; the **next launch** shows a Crash Report
  dialog: expandable "View report", an optional "What were you doing?" field,
  an "Always send crash reports" checkbox, and Send / Don't Send. "Always
  send" (also a Settings toggle) auto-sends future reports without the
  dialog. → CrashReportDialog.svelte, crashHandler.ts *(Tauri)*
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
