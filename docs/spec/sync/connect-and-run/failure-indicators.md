### Failure indicators

- **A loud failure signal fires a localized toast on diagnostic change.** Actionable failures
  toast immediately; a transient background failure toasts only when its
  reconnecting state reaches the 3-minute escalation threshold. The toast uses
  the stable catalog message for the failing source; the underlying English
  diagnostic is retained only for logs and deduplication. It appears on the
  first loud failure and on every subsequent failure whose diagnostic differs.
  An **identical** repeat stays silent — auto-sync retries a
  persistent outage every ~15s, and per-cycle toasting would spam. After a
  clear (clean sync or click-to-dismiss) the message resets, so the next
  failure toasts again. Errors are cleared **per source**: a clean completed
  sync clears cycle-failure errors but NOT a live-stream error (the stream is
  still down — clearing it would re-arm the toast and spam every reconnect
  attempt); a stream error clears when the stream reconnects or on dismiss.
  Stream and cycle diagnostics are normalized before this comparison, so alternating
  raw and browser transport wording cannot defeat dedupe. → syncManager.svelte.ts
  (`reportFailure`, `raiseSyncError`, `clearSyncError`)
- **Desktop shows a persistent idle sync indicator.** While the live SSE stream
  is connected and healthy (no active sync, no error, online), the bottom-right
  corner shows a subtle ✓ tick, so "sync is set up and fine" is always legible
  rather than blank. It yields to the spinner (syncing), muted reconnecting
  spinner, ⚠ (error), and offline icons. A failing **cycle** on a healthy stream
  does not drop the tick's connected state — the live loop reports it as `status: "cycle-error"`
  with `live: true` (only a real stream drop reports `live: false`), so one
  transient cycle error can't blank the tick until the next stream reconnect.
  Desktop only — native shells surface sync state on their Sync screen. →
  SyncStatusBar.svelte (`connected` = `sync.live`),
  `apps/tauri/src-tauri/src/sync/tauri_events.rs` (`on_cycle_error`),
  futo-notes-sync `session::run_cycle`

- **Native shells surface per-item failures on their Sync screen.** The FFI
  `SyncSummary` carries the per-item `failures` (kind, HTTP status) plus the
  core-computed `failure_message` — on `sync_now` AND live `on_synced` alike
  (the live loop forwards the full rich summary; there is no count-only live
  path). Both native SyncManagers route a completed-but-failing cycle
  (`failureMessage != null`) to the red error line verbatim — identical
  wording to desktop by construction — instead of "Sync complete", on manual
  sync, the post-connect initial sync, and live `on_synced` alike. Cleared by
  the next clean cycle. → futo-notes-ffi `SyncSummary`/`SyncFailure`,
  SyncManager.kt / SyncManager.swift (`applyOutcome`)
