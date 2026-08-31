# App — Cross-Cutting Spec

Behaviors and constraints that hold across every surface and platform.

## Render lifecycle

- The UI shell renders immediately. **Never gate first render on filesystem
  I/O.** Theme, prefs, notes, and the search index load in the background and
  apply reactively. → CLAUDE.md "Key Constraints"; `App.svelte` flips
  `initialized` synchronously. Native Android likewise reaches its first
  composition before reading theme/storage preferences or the migration
  journal; startup recovery then runs on `Dispatchers.IO` and applies
  reactively. → `MainActivity.onCreate`, `recoverStorageStartup`
- `plugin-fs` reads (`readTextFile`, `exists`) can hang indefinitely on a cold
  sandbox — never `await` one before first render. _(desktop Tauri; originally
  observed on the since-removed iOS Tauri shell — the native iOS app doesn't
  use `@tauri-apps/plugin-fs` at all)_
- If notes fail to load at startup (store init or vault bootstrap rejects), the
  app stays responsive: the notes-readiness promise settles as `failed` instead
  of leaving its awaiters (tab hydration → hash routing) pending forever, and
  the failure is logged (#33). → `initNotes` /
  `whenNotesReady` in src/features/notes/notes.svelte.ts,
  createAppBootstrap.svelte.ts
- Desktop cold start overlaps a read-only, content-free note listing with
  webview startup, then publishes the engine-ordered ids, titles, folders, and
  mtimes before hydrating previews/tags and starting search. Crash recovery,
  legacy migration, empty-vault seeding, and notes readiness remain gated on
  the authoritative full Rust bootstrap; the fast listing never mutates the
  vault or becomes authoritative for tab hydration. → `LocalNoteStore::startup_listing`,
  `local_notes_startup_listing`, `prefetchLocalNoteListing`, `initNotes`

## Notes & files

- **The filename IS the title.** `"grocery list.md"` → title `"grocery list"`.
  No case changes, no dash→space, no transformations; only filesystem-breaking
  characters are stripped. → `sanitizeTitle`
- Notes are plain Markdown files on disk — "file over app." A note's content is
  its file's bytes; renaming a note renames its file.
- Renaming a note whose new title collides with another note suffixes the id
  (`Title` → `Title-2`, `-3`, …). A **case-only or Unicode-normalization-only**
  rename (`note`→`Note`, composed↔decomposed `café`) keeps the requested form
  and never bumps to `-2`, even on case/normalization-insensitive filesystems
  (APFS, NTFS). → `futo_notes_store::paths::unique_note_id`,
  `futo-notes-model` `rename_note`
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
  browsable; changeable in Settings. Rust resolves the active/default folder
  only through `vault_location.rs`; debug builds retain the separate
  `~/Documents/fake-notes` root. → [desktop-rust.md](desktop-rust.md) "Vault
  and desktop safety boundaries"
- **iOS:** the vault lives in the app's Documents container
  (`Documents/futo-notes`) and is exposed in the Files app under
  "On My iPhone → FUTO Notes" via `UIFileSharingEnabled` +
  `LSSupportsOpeningDocumentsInPlace`. Sync state / crash logs are dotfiles
  inside the vault, which the Files app hides. Applies to all installs (it only
  reveals the existing folder — no migration). _(iOS)_
- **Android:** storage is chosen on first run (Obsidian-style picker) and is
  switchable later in Settings → Storage. On Android 11+ the picker offers two
  modes and Device storage is the pre-selected recommended default; on API < 30
  it offers only App storage because Device storage depends on All-files access:
  - **Device storage** — `Documents/FUTO Notes` on shared storage: visible in
    the stock Files app + survives uninstall. Needs the "All files access"
    (`MANAGE_EXTERNAL_STORAGE`) permission, requested behind a rationale screen
    shown before the system dialog. Android 11+ only.
  - **App storage** — `Android/data/<pkg>/files/futo-notes`: no permission, but
    invisible to the stock Files app on Android 11+ and deleted on uninstall.
    Switching modes migrates the whole vault (including the `.futo` sync state)
    and relaunches. The switch blocks editor/store writes—including image-picker
    and clipboard image files—and pauses live sync. It refuses to begin while a
    vault write is active, because an image write completes with a later editor
    insertion that must be confirmed by the WebView before the storage gate
    opens; the user can retry after that save finishes. A newly queued save is
    rejected once migration is latched. That same synchronous latch makes an
    Activity `onStop` unable to abort live sync before the migration's graceful
    sync stop completes. Editor navigation captures the latest live CodeMirror
    body and persists-or-parks it before leaving the editor; Settings is reached
    only after that navigation commit. A dirty draft retained by an unexpected
    editor disposal is additionally flushed by the store under the migration
    gate before staging. Migration never queries or waits on the detached editor
    WebView. The engine stages the copy, verifies every relative path and file
    digest, fsyncs copied files and directories, and fsyncs the
    destination-parent chain after installation. Before each authority
    transition it records a fsynced, atomically replaced app-private journal.
    `PREPARED` makes the old root authoritative after a crash.
    `FINALIZING` is written before source cleanup. Its versioned journal records
    whether policy forbids removing the source (with backward-compatible V1
    decoding). The destination has already been fully verified at this point, so
    recovery promotes it when cleanup of a removable source was interrupted and
    retains the still-present source as a backup. A source-removal-forbidden
    Device migration instead safely rolls back to its still-present source if
    activation was not durably recorded.
    `ACTIVATED` makes the verified destination authoritative even if the
    SharedPreferences commit result is ambiguous. A late source edit yields
    `DESTINATION_CHANGED`, aborts activation, and keeps the old root visible.
    Because external writers to shared Device storage cannot be fenced, a
    successful switch away from Device storage retains that source as a backup
    after activation instead of deleting it through a check-then-delete window.
    Other cleanup failures may likewise retain the source as a backup. Recovery
    distinguishes a present or proven-absent source from storage that is
    unmounted, permission-denied, or otherwise uninspectable; an unavailable
    source never authorizes destination promotion. A failed copy/verification
    keeps the old mode/root active and reports the failure.
    Every retained draft must first produce a committed mutation or already
    match the bytes on disk; a skipped/missing/divergent flush aborts the switch
    instead of relaunching with an older draft. A non-empty destination is
    accepted only when its complete manifest already matches the source, so an
    unrelated pre-existing vault is never overwritten or cleaned up. An
    existing empty source directory is a valid switch, but a missing or
    non-directory active root is a failure (never interpreted as an empty
    vault). The move is transparent to sync because the object map is keyed by
    relative filename. →
    [sync.md](sync.md), Android `storage/`, `MainActivity.performSwitch`,
    `NotesStorageTest`, `futo-notes-store::vault_migration`
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
> not visible in a file manager. _(Android)_

> **Gap:** The vault folder is fixed per mode and not a user-pickable arbitrary
> directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive
> vault option. Both are possible follow-ups. _(iOS / Android)_

## Where logic lives

- Note CRUD, rules, sync, search, and indexing logic live in Rust
  (`crates/futo-notes-*`), exposed **once** via the `futo-notes-ffi` UniFFI
  facade (iOS/Android) and `#[tauri::command]`s (desktop). Svelte / Compose /
  SwiftUI are thin shells that call in and render. →
  AGENTS.md → "Where Logic Lives"
- Deterministic editor rules (filename/tag parsing) may keep a synchronous TS
  copy in `packages/editor` to avoid a per-keystroke IPC/FFI hop, but it is
  conformance-locked bit-for-bit against the Rust impl. → tests/conformance
- The Tauri desktop Rust shell is a named adapter, not another domain layer.
  Its final module names, ownership boundaries, stable command/event surface,
  compatibility commands, watcher suppression, and inline-test convention are
  specified in [desktop-rust.md](desktop-rust.md).
- The frontend Tauri platform boundary is owned by `src/lib/platform/tauri/`:
  `adapter.ts` owns construction plus notes-root and watcher lifecycle state;
  `storage.ts` owns non-note filesystem I/O; `images.ts` owns image persistence,
  URL policy, and capability state; clipboard access is part of `PlatformFS`;
  the remaining capability files own config/root policies; and
  `src/lib/platform/tauri.ts` is only the stable public composition facade.

## Performance

- Book-length notes must stay responsive. On the open path an unbounded
  synchronous full-document parse (`ensureSyntaxTree(..., doc.length, 5000)`) is
  banned; instead the `LiveMarkdownPlugin` constructor seeds decorations with a
  tightly time-boxed (≤200 ms) `ensureSyntaxTree(..., doc.length, 200)` parse,
  then grows decorations incrementally as parsing continues
  (`scheduleParseRefresh`). → src/features/editor/live-preview/LiveMarkdownPlugin.ts

## Appearance

- A theme change (Light/Dark/Auto, including the OS moving under Auto) repaints
  every surface in the same frame. No surface fades, springs or cross-fades to
  its new colour while the rest of the window snaps.
  → scripts/check-theme-single-pace.mjs
- A colour transition may only cover a property whose rest value cannot carry a
  theme colour (`transparent`, `none`), so the animated value is reachable only
  under `:hover`/`:active` — states an unattended theme change never enters
  _(desktop)_. → src/styles/sidebar-header.css
- Top bars take their background from `TopBar`, never Material3's
  `TopAppBar` container colour, which Material runs through
  `animateColorAsState` _(Android)_. →
  apps/android/app/src/main/java/com/futo/notes/ui/components/TopBar.kt
- The theme is applied by overriding the scene's windows
  (`overrideUserInterfaceStyle`), never a root `.preferredColorScheme`: the
  latter leaves an already-presented sheet on its old appearance entirely
  _(iOS)_. → apps/ios/Sources/App/Theme.swift `appearanceOverride`

> **Gap:** _(iOS)_ A stock toolbar button's pill background — Settings' **Done**
> — repaints on UIKit's own later pass, so it trails the rest of the sheet.
> Measured on an iPhone 17 Pro simulator (iOS 26) by tapping Light/Dark and
> sampling frames: every sheet surface reaches its new colour in the same single
> frame, while the pill is ~29% of the way there. Reproduced with the app's tint
> replaced by a stock system colour, so this is platform chrome rather than FUTO
> theming, and there is no app-side fix.

## Data safety

- Dev/debug builds must never overwrite the production app or notes: a distinct
  bundle id (`com.futo.notes.dev`) and a distinct notes root
  (`~/Documents/fake-notes` on desktop). → CLAUDE.md,
  `apps/tauri/src-tauri/src/vault_location.rs`
- Production native mobile builds use the production package/bundle id
  `com.futo.notes`; native debug builds use `com.futo.notes.dev` so local
  installs keep separate app data and credentials.
- Creating a note never replaces an existing file: the vault installs it through
  an atomic no-replace primitive — a hard link, else a `RENAME_NOREPLACE` rename.
  A filesystem that supports neither, such as Android 9/10 shared storage
  (sdcardfs), falls back to an exclusive create plus copy, which still refuses to
  replace but is not atomic, so a crash mid-create can leave a truncated new
  note. → `futo_notes_core::files::atomic_write::move_no_replace`

## Display backend _(Linux desktop)_

- Packaged Linux builds use native Wayland when the session provides it. The
  AppImage launch hook sets `GDK_BACKEND=wayland,x11` only when the user has not
  set `GDK_BACKEND`, replacing tauri-bundler's unconditional X11 export that
  opened the AppImage (and AUR packages derived from it) under XWayland (#14,
  upstream tauri#8541). A user-selected backend is preserved. Debian and RPM
  packages follow the system GTK backend selection. →
  `scripts/patch-appimage.mjs`, `scripts/patch-appimage.test.mjs`
- The AppImage strips its bundled `libwayland-client.so.0` so native Wayland
  uses the host library that matches host Mesa. WebKitGTK DMA-BUF rendering
  remains disabled through `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the desktop
  process setup. Diagnosis verified 2026-07-21 on CachyOS/niri: the unpatched
  AppImage connected through XWayland while the unpackaged binary connected to
  `wayland-1`. The hook rewrite, user override, and X11 fallback policy are
  guarded by `scripts/patch-appimage.test.mjs`. Packaged runtime verified
  2026-07-22 on CachyOS/niri via socket-peer inspection: unpatched AppImage →
  `@/tmp/.X11-unix/X1` (XWayland); patched AppImage → `/run/user/1000/wayland-1`
  with no EGL abort; `GDK_BACKEND=x11` override honored; with `WAYLAND_DISPLAY`
  unset the `wayland,x11` list falls back to X11 and launches. →
  `scripts/patch-appimage.mjs`, `apps/tauri/src-tauri/src/main.rs`

## Soft keyboard _(Android)_

- Dismissing the soft keyboard by the system back gesture/button drops the
  focused field's caret, app-wide — Android hides the IME without clearing
  focus, and a caret with no keyboard has no function (#24). The drop is
  INSTANT: it keys off `imeAnimationTarget` (the hide animation's START),
  not the live IME inset (its end) — waiting out the slide-down reads as
  lag. The root `ClearFocusOnImeDismiss` covers every screen in the
  Activity window, and its `onDismiss` hook blurs the editor WebView over
  the bridge (its DOM caret survives a view-level clearFocus — see
  [editor.md](editor.md)); a dialog hosting a text field installs its own
  (a Dialog is its own window with its own focus manager).
  → ui/components/ImeDismiss.kt, MainActivity.kt, NewFolderDialog.kt,
  CrashReportDialog.kt, EditorImeDismissBlurTest.kt
- Focusing a dialog text field leaves the keyboard up until the user
  dismisses it. Every `ClearFocusOnImeDismiss` is passed IME visibility read
  in the ACTIVITY window (a dialog composable reads it in its function body),
  never its own window's — a dialog window's insets flicker as the keyboard
  opens, and a dialog-local reading closed it, making folder creation
  impossible (github#23). → ui/components/ImeDismiss.kt, DialogImeDismissTest.kt
- iOS can't hit this: hiding the keyboard means resigning first responder,
  which drops the caret with it — the two are coupled on iOS, and the editor's
  only dismiss affordance (the toolbar chevron) blurs over the bridge.

## Dialogs _(desktop)_

- **Escape dismisses the top-most dialog or overlay, from wherever focus is** —
  including from a text field inside it — and never more than one at a time. It
  is a property of dialog composition, not of each dialog: `Modal.svelte` (used
  by every standard modal) and the `use:dismissable` action (used by overlays
  with bespoke chrome — crash report, context menu, search, settings) share one
  document-level handler and a dialog stack. Escape consumed by an open overlay
  does not also reach the editor or the screen behind it. → shared/dialogs/dismissable.ts,
  shared/dialogs/Modal.svelte, shared/dialogs/dismissable.test.ts
- A standard modal is `role="dialog" aria-modal="true"`, named by its title,
  traps Tab inside the card, dismisses on a backdrop click, and returns focus to
  whatever was focused when it opened. → shared/dialogs/Modal.svelte
- Secondary/cancel buttons in dialogs carry a hover affordance, gated behind
  `@media (hover: hover) and (pointer: fine)` so a touch shell never leaves a
  button stuck in its hover state. → shared/dialogs/modal.css,
  crashReportDialog.css, settingsBlockingOverlay.css
- `window.confirm()` / `window.alert()` don't block in Tauri's webview — use
  `ask()` / `message()` from `@tauri-apps/plugin-dialog`. → CLAUDE.md
- Confirmation prompts go through `confirmDialog()` (`src/shared/dialogs/confirmDialog.ts`):
  `ask()` under Tauri, `window.confirm()` in the plain web shell (dev server,
  Playwright) where plugin-dialog has no backend and would reject. → confirmDialog.ts

## Updates _(desktop self-update)_

- On launch (and then hourly), desktop builds that can self-update silently
  check the updater endpoint. A found update raises a small floating banner
  (bottom-right, above the sync status bar): a single **Update & restart**
  button — clicking anywhere on it downloads + verifies (minisign) + installs
  (showing a progress bar), then relaunches into the new version.
  → UpdateBanner.svelte, updateChecker.svelte.ts
- The launch/hourly checks are **silent**: a failed check (e.g. offline) never
  shows the banner or an error, and "you're already up to date" shows nothing.
  Only a user-initiated check (Settings → Updates) surfaces those outcomes; an
  install the user started from the banner surfaces its own error with a Retry.
- The banner has no dismiss control: it stays until the update is installed,
  the release is retracted, or updates are disabled in Settings.
  → UpdateBanner.svelte test "has no dismiss control"
- The banner and the Settings → Updates button share one state machine
  (`updateChecker`) — same pending version, progress, and install path — so a
  check or install from either is reflected in the other. The checker is
  started from App.svelte's background init and never gates render; it no-ops
  where self-update isn't possible (mobile/web, deb/rpm). → updates in
  settings.md, App.svelte, `apps/tauri/src-tauri/src/updater_commands.rs`

## Feedback & crash reporting

- Action feedback uses transient toasts (~3 s, one at a time, auto-dismiss):
  "Note deleted", "Moved to {folder}", "Folder created", "Path copied", etc. _(Tauri; Android
  native shows the same platform toasts — delete now toasts "Note deleted" from
  both the editor ⋮ menu and the list long-press)_ → shared/notifications/toastBus.svelte.ts,
  NoteEditorScreen.kt, NoteListScreen.kt
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
  CrashReportDialog.kt _(Android)_, CrashReporter.swift _(iOS)_
