## Live sync (SSE)

- After connecting, the client opens the server's SSE stream
  (`GET /api/sync/events`) and pulls automatically on every `ready`/`change`
  event, so a remote edit appears **without a manual "Sync now"**. The stream
  state is NOT surfaced as a "Live" label — that label was removed everywhere
  (2026-06-04): it tracked the reconnect task being alive, not an
  authenticated stream, so it stayed lit while every request 401'd. Errors
  surface via the status/lastError line instead. On desktop, the live loop's
  error emits (`sync:live-state` with a `message`) also route through the same
  normalized transient/actionable classifier as every other desktop sync error
  — previously the message was dropped and a failing live loop stayed quiet until the (up to
  120 s) safety poll hit the same error. The loop distinguishes its two
  failure classes: a failed **cycle** on a healthy stream emits
  `status: "cycle-error"` (`live: true` — same class as a poll failure,
  cleared by the next clean sync) while a **stream** connect/read failure
  emits `status: "reconnecting"` (`live: false`, cleared when the stream
  reconnects or on dismiss — deliberately NOT by a clean poll, which proves
  syncing works but not that the stream recovered). → futo-notes-sync
  `session/` (`SyncSessionListener::on_error`), `SyncClient::start_live`
  (native), `e2ee_start_live` + syncManager.svelte.ts (`handleLiveState`) +
  SyncStatusBar.svelte (desktop)
- The `change` event is a doorbell only (`{collectionId, currentVersion}`, no
  content); the client always pulls from its persisted `max_version` cursor, so
  it is robust to missed/duplicated events.
- The stream is lossy across disconnects (the server replays nothing), so the
  client also runs a ~45 s safety poll while connected, during reconnect
  backoff, and while a new stream handshake is pending. It reconnects with exponential backoff;
  a fresh `ready` drives a catch-up pull. This safety poll is also the only path
  that catches mutations the server emits no event for (collection
  create/delete, key rotation). The same Rust task runs on iOS and Android,
  so a proxy that never establishes SSE cannot strand native sync after launch.
  → `session/live/runner.rs`, guarded by
  `hung_event_handshake_still_runs_the_safety_poll`.
- **Every finite server request has a total deadline.** The auth-mode probe
  times out after 5 s; login, collection/key/object requests, deletes, and blob
  transfers with no known size use a 30 s total-request timeout. Known-size
  encrypted blob uploads and downloads add one second for each complete
  128 KiB of expected payload to that 30 s baseline (for example, 32 MiB gets
  286 s and 100 MiB gets 830 s). Uploads scale with the real ciphertext body
  length, uncapped, so a server configured above the default 100 MiB blob
  limit still gets fully provisioned uploads. Downloads scale with an expected
  size the client did not measure itself — ordinary pulls use the
  server-reported encrypted `size_bytes`, the conflict merge-base fetch uses
  the checkpoint-recorded plaintext size (a close proxy for the ciphertext) —
  so the expected size is capped at 100 MiB: a corrupt or hostile size cannot
  extend a download deadline beyond 830 s. The
  advisory `size_bytes` field itself degrades to unknown (30 s deadline) on an
  unparseable value instead of failing the pull. TCP connection establishment is
  bounded to 10 s. The SSE event stream uses a separate client with no
  total-request timeout so a healthy long-lived stream is never torn down at
  30 s. Its finite setup phases are still bounded: response headers and any
  non-success response body each get 30 s. Once a successful stream starts, the
  live loop's 90 s read-idle watchdog detects a stall. This split prevents a
  server that accepts TCP and then stalls a finite response from leaving connect
  or sync pending forever without imposing a finite lifetime on a successful
  SSE body. →
  futo-notes-sync `server.rs`, guarded by
  `ordinary_requests_have_a_total_timeout`,
  `ordinary_response_bodies_have_a_total_timeout`,
  `auth_mode_uses_the_short_probe_timeout`,
  `blob_download_without_known_size_uses_the_base_request_timeout`,
  `blob_download_timeout_scales_with_expected_size`,
  `blob_upload_timeout_scales_with_payload_size`,
  `transfer_timeout_scales_with_expected_bytes`,
  `download_timeout_caps_untrusted_expected_size`,
  `upload_timeout_scales_past_the_download_cap`,
  `unparseable_size_bytes_degrades_to_none`,
  `merge_base_fetch_deadline_scales_with_checkpoint_size`,
  `event_stream_has_no_total_request_timeout`,
  `event_stream_response_headers_have_a_timeout`, and
  `event_stream_error_body_has_a_timeout`
- The live stream is paused when the app is backgrounded and resumed on
  foreground (re-foregrounding gets a fresh `ready` → catch-up). → Android
  MainActivity `onStart`/`onStop`; iOS `FutoNotesApp` `scenePhase`
  (`SyncManager.pauseLive`/`resumeLiveAsync`).
- A stop wins over any start asked for before it: a `stop_live` (or
  `stop_live_and_wait`, or the stop inside connect/resume/disconnect) that
  lands after `start_live` was called but before the start ran voids that start,
  which then returns success without opening a stream — so backgrounding the app
  right after a foreground cannot leave live sync running in the background
  (#278). A start asked for after the stop runs normally. → futo-notes-sync
  `SyncSession::start_live`, guarded by
  `stop_live_voids_a_start_live_that_has_not_run_yet` and
  `stop_live_before_the_queued_start_live_runs_leaves_no_live_task` (FFI)
- Live sync is wired on native **Android and iOS** — both implement the Rust FFI
  `SyncEventListener` callback over the same `start_live`/`stop_live`. → SyncScreen.kt
  (Android), SyncManager.swift + SyncView.swift (iOS)
- A native shell never starts live sync while the app is in the background. A
  start asked for before the app was backgrounded — the one after a connect's
  first cycle, or a foreground resume still waiting behind other sync work — is
  dropped if the app is in the background when its turn comes, and the next
  foreground starts live sync instead. → Android
  `SyncManager.startLiveInForeground` (SyncManagerLifecycleTest.kt); iOS
  `SyncManager.startLive` (SyncManagerLiveLifecycleTests.swift)
- Live sync is also wired on **Tauri desktop** — Rust `e2ee_start_live` /
  `e2ee_stop_live` drive the same `SyncSession`, emitting
  `sync:live-state` (tracks stream health internally via `setLiveConnected`; no
  user-facing "Live" label is rendered) and
  `sync:live-synced` (carries the per-note `SyncSummary`, which the JS routes
  through the normal `handleSyncComplete` reconciliation so the open note + list refresh live;
  its arrival also advances the live edit epoch — see the draft-protection section).
  `ensureLiveSync()` starts the stream after the first successful sync; the 15 s
  poll remains the fallback. →
  `apps/tauri/src-tauri/src/sync/cycle_runner.rs`,
  `apps/tauri/src-tauri/src/sync/tauri_events.rs`,
  syncServiceE2ee.ts, syncManager.svelte.ts
- When a sync cycle changes the local notes tree, the note list (and the open
  editor's on-disk base) refreshes automatically so the change appears without
  any user action. Every shell passes the complete changed-id and rename report
  to the store-owned `refresh_external_changes`, which projects only affected
  rows at their canonical
  Rust-computed positions. Desktop applies the returned mutation before it
  reconciles the open note; native shells pass the complete `SyncSummary`
  through `SyncManager.onLocalTreeChanged` to `NotesStore.localTreeChanged`.
  That verb rechecks final filesystem state, so a
  callback racing a recreate/flush cannot delete the recreated row, and sends
  scoped changed/removed notifications to search. If scoped projection fails,
  a shell falls back to search reconciliation plus a full snapshot, then
  still delivers the summary so the open editor can reconcile from disk. →
  desktop `refreshNotesAfterSync` / `local_notes_refresh_external_changes`;
  iOS `FutoNotesApp` / `NotesStore.swift`; Android `MainActivity` / `NotesStore.kt`;
  futo-notes-store `refresh_external_changes`
  - The refresh fires on the core-computed `SyncSummary.localWritesApplied`, not
    only `downloaded`/`deleted` — a **push-side** clean merge (`MergedClean`)
    writes merged text to local disk while reporting `uploaded`, so gating on
    downloads/deletes alone let a stale open native editor's next autosave
    clobber the peer's merged-in edit (F2). → `SyncManager.wroteLocalChanges`
    (iOS/Android), guarded by `SyncManagerLocalTreeChangeGateTest` (Android) +
    `combine_summaries_carries_local_writes_applied` (core).
- **Local edits auto-push on Tauri desktop AND the native shells.**
  - Desktop: a local save triggers a debounced push (`notifySaved` → `run_sync`),
    and the desktop live loop runs a full `run_sync` (push + pull) on each event,
    so a desktop edit propagates to peers automatically (debounce + SSE pull on the
    peer, well under a couple seconds). → autoSync.ts,
    `apps/tauri/src-tauri/src/sync/cycle_runner.rs`
  - Native (iOS/Android): every `NotesStore` mutation (write/create/delete/rename/
    move/createFolder) fires `NotesStore.onLocalChange` → `SyncManager.noteChanged()`
    → the Rust `SyncClient::note_changed()` write-once auto-push signal. The live
    loop debounces and pushes the edit; peers then receive it within ~1 s via SSE.
    Fire-and-forget and a no-op when not connected. → `NotesStore.onLocalChange`
    (wired in iOS `FutoNotesApp` / Android `MainActivity`), `SyncClient::note_changed`,
    futo-notes-sync `session/` (debounced push branch)
- The native session (auth token + vault key) is in-memory, but **all three
  shells persist the sync password in the OS secret store and auto-reconnect on
  a cold launch**, so live sync survives a force-quit / process death: iOS
  stores it in the Keychain (`kSecAttrAccessibleWhenUnlocked`); Android encrypts
  it with an Android Keystore AES-GCM key (alias `futo.sync`, ciphertext in
  SharedPreferences); desktop stores it in the OS keyring via the
  `e2ee_password_*` Tauri commands (Secret Service on Linux, Keychain on macOS,
  Credential Manager on Windows), scoped per-vault by the notes-root path so the
  dev `fake-notes` and prod `futo-notes` vaults never share a credential. The
  password is **never** written to disk in plaintext — desktop previously kept
  it as `e2eePassword` in `.app-state.json` under the notes root (F6); on first
  load a legacy value is migrated into the keyring and the JSON field scrubbed
  (only after the keyring write is confirmed; an interleaved save can't strand
  the password, and a failed keyring write leaves the plaintext in place for a
  retry rather than losing it). When the desktop secret store is unavailable
  (e.g. headless Linux with no Secret Service), the app never falls back to disk
  plaintext: it runs the session password-less. There is no proactive prompt on
  the next launch — the connection metadata still marks sync as configured, so
  the Settings sync section keeps the password field available for the user to
  re-enter it on demand. A failed keyring _delete_ on disconnect/forget/Full
  reset surfaces a toast and sets a non-secret `pendingKeyringDeletion` marker
  in `.app-state.json` that the next launch retries. The tradeoff is shared and
  deliberate:
  storing the password on-device means device compromise → password → vault key.
  The stored password is cleared on explicit disconnect (after which a relaunch
  stays local), by Full reset (desktop `resetAllNotes` → `disconnectE2ee`
  deletes the keyring entry, M4), and by a hosted connect — see "Exactly one
  sync credential exists at a time" under "Hosted sync". Verified on the emulator 2026-06-09: connect →
  `am force-stop` → relaunch reconnects silently (SYNCED); disconnect → relaunch
  stays LOCAL.
  On web (non-Tauri, not a shipping sync surface) there is no OS keyring, so the
  password is held in memory only and is deliberately not persisted across a
  page reload.
  → Keychain.swift _(iOS)_, SecureStore.kt _(Android)_,
  sync/password_store.rs + syncServiceE2ee.ts _(desktop)_
- **Desktop self-hosted bearer tokens are kept in the per-vault OS keyring.**
  `.app-state.json` keeps the non-secret server URL and connection identity but
  never writes `e2eeAuthToken` for a new connection. A legacy token in that
  field is moved to the keyring and the field scrubbed on launch; when the
  keyring is unavailable, the app removes the plaintext token and can obtain
  a fresh one from its securely saved password. → appState.ts,
  syncServiceE2ee.ts, sync/password_store.rs (`syncPassword.test.ts`)
- **An expired server bearer session reauthenticates transparently from the
  securely saved password without resetting sync state — in password mode.**
  This whole paragraph is about password mode, where the login password is also
  the vault secret and is on the device, so a 401 can be recovered from without
  asking anyone anything. Hosted sync stores no password and cannot do this: its
  expired session surfaces as "log in again" with every byte of sync state left
  alone (see "Hosted sync" above). Server bearer tokens
  have a fixed seven-day lifetime that authenticated activity does not extend;
  a 401 therefore does NOT mean the password changed. Desktop catches
  401 during cold `resume` and an active sync, stops the dead live loop, calls
  `connect` with the saved password, and retries once. iOS/Android catch the
  typed `Auth` error from a manual cycle and the terminal `auth:` live-cycle or
  live-connect signal and rebuild the client from Keychain/Keystore credentials.
  If secure credentials are unavailable, the original error remains visible
  instead of the recovery silently doing nothing. Reconnect
  does **not** call disconnect or delete `.e2ee-state.json`, so reconnecting to
  the same collection retains `max_version` + the object map and remains an
  incremental sync; **Reset connection** is an explicit destructive session
  reset and still causes a full bootstrap pull from cursor 0. On desktop, if
  the saved password was deliberately forgotten, entering it in Settings and
  pressing **Sync now** uses this same non-destructive reauthentication path
  (the old field cleared the typed password without using it). →
  syncServiceE2ee.ts, createSyncSettings.svelte.ts, SyncManager.swift /
  SyncManager.kt; guarded by
  syncServiceE2ee.test.ts, createSyncSettings.test.ts,
  `auth_cycle_errors_stop_and_emit_reauthentication_signal`, and
  SyncManagerDefaultsTest.kt
