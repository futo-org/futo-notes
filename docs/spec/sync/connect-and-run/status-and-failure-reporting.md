### Status and failure reporting

- When no server is connected yet, the Sync screen points the user at how to
  get one: a **bordered link row** — a leading external-link icon (iOS
  `arrow.up.forward.square` / Android `OpenInNew`) followed by the
  accent-colored copy **"To set up sync, use FUTO Notes server."** — that opens
  the FUTO Notes server repo
  (<https://gitlab.futo.org/futo-notes/futo-notes-server>). Both shells render
  the row with the same treatment (a tappable card, not loose text).
- **The link is only shown in the not-connected state.** Once sync is set up
  (connected to a server), the link is hidden — the Sync screen then shows the
  locked server URL, "Sync now" / "Disconnect", and status instead. →
  SyncView.swift _(iOS)_, SyncScreen.kt _(Android)_
- Errors surface inline; a progress indicator shows while a sync is busy.
- A sync that finishes successfully reports just **"Sync complete"** — the
  status never shows uploaded/downloaded/deleted/conflict counts (spec
  decision 2026-06-10; the native shells previously showed
  `Synced — ↑a ↓b ✕c ⚠d`, and Tauri desktop previously showed `Synced: N
uploaded, …` / `Synced N notes`). This holds on **all three** shells. →
  SyncManager.kt / SyncManager.swift `describe`, syncManager.svelte.ts _(desktop)_
  - **Desktop has a SINGLE completion reporter.** All sync-outcome feedback
    (the "Sync complete" toast, the failure indicator/toast, the large-sync
    banner) is decided in ONE place — the sync manager's `handleSyncComplete`,
    which sees every sync (manual, poll, live SSE) with its trigger. A clean
    **manual** sync (Settings Connect / "Sync now") toasts "Sync complete";
    clean background/live cycles stay quiet. SettingsScreen owns no success
    reporting of its own — only transient progress text and the errors the
    manager never sees: pre-sync connect failures (bad URL/password) and a
    manual sync that never executed a cycle (offline, sync already running).
    Executed-cycle errors are marked by autoSync (`wasSyncErrorReported`)
    so Settings renders exactly the rest locally instead of swallowing them. →
    syncManager.svelte.ts (`handleSyncComplete` + trigger), autoSync.ts
    (`SyncTrigger`, `wasSyncErrorReported`), SettingsScreen.svelte
  - **"Sync complete" requires a genuinely clean cycle.** A cycle that
    resolves but carries per-item failures reports the failure state instead —
    resolution alone is not success. Same rule for the large-sync coordinator
    banner. → syncManager.svelte.ts (`handleSyncComplete`)
- **Desktop sync failures escalate by recourse, not by first failure.** A
  transport-class background failure (the shared `RUST_TRANSPORT_ERROR` match
  or an opaque fetch `TypeError`) first enters a visible-but-quiet reconnecting
  state: the status bar shows a muted spinner, Settings shows the localized
  reconnecting message,
  and neither the ⚠ state nor a toast fires. Retries remain active; if the same
  source is still failing after 3 minutes, the next retry promotes it to the
  existing loud state with the muted ⚠ indicator, localized hover and Settings
  messages, and a localized toast. A clean cycle clears cycle reconnecting;
  a stream reconnect clears stream reconnecting. Failures are never swallowed:
  the quiet state is visible and self-escalates without user action. Manual
  "Sync now" / Settings-connect cycle failures, auth failures, errors carrying
  an HTTP status, and completed-cycle per-item failures are actionable and loud
  immediately. Pre-sync bad-URL/password failures remain local to Settings. The
  ⚠ is click-to-dismiss (`clearSyncError`) — a dismiss, not a mute, so a later
  failure can raise it again. Raw failures remain English diagnostics for
  classification, deduplication, logging, and crash reports; the user-facing
  boundary resolves a stable source-specific catalog message and does not expose
  server URLs or reqwest internals. Download-per-item retry failures remain immediately
  actionable for now. → syncErrorClassification.ts (`classifySyncError`,
  `syncErrorDedupeKey`), syncManager.svelte.ts (`reportFailure`,
  `reconnecting`, `syncError`), SyncStatusBar.svelte, SyncSettingsSection.svelte

  > **Gap:** iOS/Android SyncManagers still escalate on the first failure with no transient/actionable classification (single error bucket); desktop-only as of 2026-08-24.
  - **A transport failure retains its complete cause chain in the engine and
    journal.** Anything that never reached a status line — DNS,
    no route, a refused or reset connection, a stale pooled socket, TLS, a
    timeout, a truncated body — carries the whole error `source()` chain
    (`error sending request for url (…): client error (Connect): tcp connect
error: No route to host (os error 65)`) in the journal's `error` field; the
    desktop user-facing boundary normalizes transport-class details as described
    above. The outer layer alone is untriageable: a desktop
    journal held 240 failed cycles over three days that could not be told apart
    from a dead server, a poisoned connection pool, or a vanished route. →
    futo-notes-sync `server/mod.rs` (`transport_error` / `error_chain`, guarded
    by "a refused connection names its cause not just the url")
  - **Every per-item failure carries its cause to the journal.** `SyncFailure`
    has a `detail` field holding the engine's own error text — the `HttpError`
    chain for a download, the vault-relative write error for a local apply, the
    status detail for an upload — and each pull-side failure records a
    `decision: "failed"` line with it. Journal-only: neither shell contract
    projects `detail` (guarded by
    "every failure field is either projected or deliberately internal"), and the
    user-facing string stays the core-computed `failure_message`. Before this a
    download or decrypt failure journaled NOTHING at all and a local apply
    journaled only `reason: "apply_error"`, so `just journal last-sync` showed a
    failure count and no cause — the exact gap github#44 was closed without.
    → futo-notes-sync `sync/pull/mod.rs` (`record_apply_failure`,
    `apply_live_object`), `sync/outcome.rs` (`SyncFailure::detail`)

- **A cycle with no vault folder stops before its first write, names the folder,
  and leaves it alone.** `cycle_with_checkpoint` checks `root.is_dir()` ahead of
  the bootstrap pull, the push and the pull, and fails the whole cycle with
  "Can't find your vault folder at <path>. Please reconfigure in settings."
  — the same sentence the desktop's own `resolve_root` returns for a vanished
  custom root, so the two entry points read alike. Nothing in the cycle may
  create the folder: `checkpoint::save` goes through `write_atomic_text`, which
  does `create_dir_all` on the parent, so a missing vault used to be silently
  replaced by a stub holding only `.e2ee-state.json` — directly against the
  desktop rule that a vanished custom vault is never replaced by an empty
  directory (an unmounted drive or a revoked portal grant would get notes
  written into a fresh empty directory standing where the vault was).
  github#44: the reporter's desktop instead said "3 notes couldn't be downloaded
  (will retry)" while every blob downloaded and decrypted correctly, and he
  audited a healthy server, a healthy nginx and his server logs before creating
  the folder by hand.
  → futo-notes-sync `sync/mod.rs` (`cycle_with_checkpoint`,
  `SyncErrorKind::VaultMissing`), guarded by
  "a cycle with no vault folder names it and does not recreate it";
  `apps/tauri/src-tauri/src/vault_location.rs` (`VAULT_UNAVAILABLE`,
  `resolve_root`), `src/app/startNativeShell.ts`

  > **Gap:** the native shells fold this into UniFFI's generic `SyncError::Io`, so iOS/Android render it as an I/O error rather than naming the folder — a new `SyncError` variant needs regenerated Swift + Kotlin bindings and a branch in both hosts; as of 2026-09-02 the sentence survives only in the payload.

- **Per-item sync failures surface — a cycle that COMPLETES is not assumed
  healthy.** When individual operations fail (an upload/create/update, a
  push-side delete, a duplicate-move loser takedown, an object-map
  checkpoint persist, or a pull-side blob download/decrypt) but the cycle
  itself
  doesn't throw, they are counted into `SyncSummary.failures` (a channel
  distinct from `conflicts`) and drive the SAME ⚠ indicator + Settings
  line as a whole-cycle failure. Previously these returned `Ok` and were
  swallowed to stderr — invisible in packaged builds — so a server rejecting
  every upload (the 2026-06-29 EACCES/HTTP-500 incident) showed **no** client
  signal for days. The Rust core computes `SyncSummary::failure_message` as a
  diagnostic. Shells render catalog messages for the visible status line and
  use structured failures to name 413 and rejected-path files.

  > **Gap:** _(desktop)_ for other failure kinds, the core message is NOT
  > rendered verbatim — the desktop shell discards it. `raiseSyncError` sets the user-facing
  > `syncErrorMessage` to `syncErrorForSource(source)`, a fixed catalog string
  > per source (`sync.errors.completedWithErrors`, or
  > `sync.errors.liveUnavailable` for the stream), and stores the core's own
  > sentence in `syncErrorDiagnostic` — a plain non-reactive `let` that is read
  > only to dedupe repeat failures and is never rendered anywhere. So the
  > vanished-vault cycle above computes "Can't find your vault folder at
  > <path>. Please reconfigure in settings." correctly (verified: the cycle
  > names the folder and does not recreate it) and the user still reads "Sync
  > completed with errors. Some changes could not reach the server." That is
  > github#44's original symptom — a message that sends the user to audit the
  > server instead of the folder — surviving on desktop through this path.
  > Pre-existing: `raiseSyncError` has behaved this way since `bdcee4ba`
  > (2026-08-24), so commit 5b81bc9a fixed the core and the startup path but
  > never this surface. Note this line and the classification bullet above
  > ("the user-facing boundary resolves a stable source-specific catalog
  > message") contradict each other; the code implements the latter.
  > → syncManager.svelte.ts (`raiseSyncError`, `syncErrorForSource`)

  The core wording, when a shell does render it: server-bound failures (upload/delete) read "N change(s) couldn't
  reach the server", with the most common HTTP status appended when one
  exists (ties keep the first-seen code, deterministically on every
  platform); pull-side download failures read "N note(s) couldn't be
  downloaded (will retry)", with the most common HTTP status appended the same
  way — the status was collected and silently dropped until 2026-09-02, so an
  nginx 502 and a vanished folder rendered identically — and the retry promise
  is real, see the cursor-cap bullet below; a remote change that arrived intact
  and could not be applied to the vault reads "N change(s) couldn't be applied
  to your notes folder (will retry)", never the network wording, because the
  bytes are already in hand and a read-only mount, a full disk, an unwritable
  subfolder, a local edit that landed mid-pull, or a remote deletion this client
  cannot carry out has nothing to do with the server, and "change" rather than
  "note" because a failed deletion lands here too (github#44: all of these
  reported as failed downloads); a missing vault folder answers ALONE and by
  path, per the bullet above, because it explains every other failure in the
  cycle; decrypt failures read "N note(s) couldn't be decrypted",
  kept out of the network wording because they indicate key material or
  corruption, not connectivity; a checkpoint failure is a LOCAL persist
  error — the data did
  reach the server — so it gets its own clause ("sync state couldn't be
  saved locally"), never the server wording, and is recorded at most once
  per cycle even when the interim and final persists both fail.
  An HTTP 413 upload stays in `conflicts` for existing accounting and also
  enters `failures` (with filename and status), including cycles that skip the
  unchanged file after the original rejection. Every shell shows a catalog
  message naming the affected files and the server or proxy size limit.
  Unresolved-merge outcomes stay in `conflicts`, not `failures`. Partial cycles report honestly — a cycle can have both
  `uploaded > 0` and failures.
  → futo-notes-sync (`SyncFailure`, `FailureKind`,
  `SyncSummary::failure_message`, push/pull cycle),
  `apps/tauri/src-tauri/src/sync/frontend_contract.rs` `SyncSummary::from`,
  syncManager.svelte.ts
  (`handleSyncComplete`)
