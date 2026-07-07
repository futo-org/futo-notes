# Sync — Spec

E2EE sync. **All sync logic lives in the Rust `futo-notes-sync` crate**; every
shell only drives it. Native (iOS/Android) goes through the `futo-notes-ffi`
`SyncClient`; Tauri desktop goes through the `e2ee_*` Tauri commands (a thin
`sync.rs` wrapper) + `syncServiceE2ee` + coordinator — both now run the **same**
orchestrator (`connect`/`run_sync`/`run_pull`/`run_push`/`live::watch`). The
client uploads opaque encrypted blobs — note content is encrypted before upload.

## Connect / run

- Connecting requires a server URL + password; a successful connect auto-runs a
  first sync. → SyncScreen.kt
- Once connected, the server URL is locked. The user can "Sync now" or
  "Disconnect". → SyncScreen.kt
- **The password and server-URL fields suppress IME text "help."** Both declare
  the right soft-keyboard type (password / URI) and disable autocapitalization
  and autocorrect/predictive text. A default text field on a phone silently
  capitalizes the first character or autocorrects, so the bytes sent to the
  server differ from what the user typed — surfacing as a spurious "invalid
  password" or an unreachable host even when the input looks correct. → iOS
  `SecureField` + `.textInputAutocapitalization(.never)`/`.autocorrectionDisabled()`
  on the URL field (SyncView.swift); Android `KeyboardOptions(keyboardType =
  Password/Uri, autoCorrectEnabled = false, capitalization = None)`
  (SyncScreen.kt); desktop `type="password"` + `autocapitalize="off"`
  (SettingsScreen.svelte).
- **A server URL without an `http://` or `https://` scheme is rejected before
  any network call**, with the actionable message *"Add http:// or https:// to
  the start of the server URL."* (surrounding whitespace is trimmed). This turns
  the most common setup mistake into a clear instruction instead of an opaque
  transport error. All three shells pre-validate identically: Android
  `SyncManager.validateServerUrl`, iOS `SyncManager.validateServerURL` (guards
  `connectAndSync`), and desktop `validateSyncServerUrl` (thrown from
  `connectE2ee` before the `e2ee_connect` invoke; surfaced via
  `getSyncErrorMessage`). → SyncManager.kt / SyncManager.swift /
  syncServiceE2ee.ts
- **A plain-`http://` sync server is permitted on every build type, including
  production.** Self-hosters and testers can point at a server without TLS (a
  LAN box, a VPS, or localhost); note content is E2EE-encrypted client-side
  before upload, so cleartext transport carries only opaque blobs + auth. HTTPS
  is still recommended. → Android `AndroidManifest.xml`
  `usesCleartextTraffic="true"` (all build types); iOS `Info.plist`
  `NSAppTransportSecurity → NSAllowsArbitraryLoads` (shared by Debug + Release
  via `project.yml` `settings.base`).
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
  SyncView.swift *(iOS)*, SyncScreen.kt *(Android)*
- Errors surface inline; a progress indicator shows while a sync is busy.
- A sync that finishes successfully reports just **"Sync complete"** — the
  status never shows uploaded/downloaded/deleted/conflict counts (spec
  decision 2026-06-10; the native shells previously showed
  `Synced — ↑a ↓b ✕c ⚠d`, and Tauri desktop previously showed `Synced: N
  uploaded, …` / `Synced N notes`). This holds on **all three** shells. →
  SyncManager.kt / SyncManager.swift `describe`, syncManager.svelte.ts *(desktop)*
  - **Exemption:** the "no counts" rule covers *success* reporting only. A
    **failure** count/status (e.g. "3 changes couldn't reach the server (HTTP
    500)") is a distinct, actionable signal and IS surfaced — see the
    per-item failure bullet below.
  - **Desktop has a SINGLE completion reporter.** All sync-outcome feedback
    (the "Sync complete" toast, the failure indicator/toast, the large-sync
    banner) is decided in ONE place — the sync manager's `handleSyncComplete`,
    which sees every sync (manual, poll, live SSE) with its trigger. A clean
    **manual** sync (Settings Connect / "Sync now") toasts "Sync complete";
    clean background/live cycles stay quiet. SettingsScreen owns no success
    reporting of its own — only transient progress text and the errors the
    manager never sees: pre-sync connect failures (bad URL/password) and a
    manual sync that never executed a cycle (offline, sync already running).
    Executed-cycle errors are marked by autoSyncV2 (`wasSyncErrorReported`)
    so Settings renders exactly the rest locally instead of swallowing them. →
    syncManager.svelte.ts (`handleSyncComplete` + trigger), autoSyncV2.ts
    (`SyncTrigger`, `wasSyncErrorReported`), SettingsScreen.svelte
  - **"Sync complete" requires a genuinely clean cycle.** A cycle that
    resolves but carries per-item failures reports the failure state instead —
    resolution alone is not success. Same rule for the large-sync coordinator
    banner. → syncManager.svelte.ts (`handleSyncComplete`)
- A failed **auto/background** sync (not just a manual "Sync now") surfaces too,
  not only in the console: the desktop status bar shows a muted error indicator
  (a ⚠ warning triangle, distinct from the offline icon, which wins when there's no network)
  whose hover tooltip carries the error message, and the Settings sync section
  shows the same "Sync failed: …" line. Both clear on the next successful sync.
  Manual-sync errors ride the SAME shared state (single reporter — see above);
  only pre-sync connect failures (bad URL/password) render as a local
  "Connect failed: …" line in Settings.
  The ⚠ indicator is also **click-to-dismiss** (`clearSyncError`) — a manual
  dismiss, not a mute: the next failing sync re-raises it.
  Opaque `fetch` `TypeError`s (server unreachable) are rewritten to an actionable
  message. → syncManager.svelte.ts (`getSyncErrorMessage`, `syncError`,
  `clearSyncError`), SyncStatusBar.svelte (`onclear`), SettingsScreen.svelte (desktop)
- **Per-item sync failures surface — a cycle that COMPLETES is not assumed
  healthy.** When individual operations fail (an upload/create/update, a
  push-side delete, a duplicate-move loser takedown, or an object-map
  checkpoint persist) but the cycle itself
  doesn't throw, they are counted into `SyncSummary.failures` (a channel
  distinct from `conflicts`) and drive the SAME ⚠ indicator + Settings
  line as a whole-cycle failure. Previously these returned `Ok` and were
  swallowed to stderr — invisible in packaged builds — so a server rejecting
  every upload (the 2026-06-29 EACCES/HTTP-500 incident) showed **no** client
  signal for days. **The user-facing message is computed ONCE, in the Rust
  core** (`SyncSummary::failure_message`) and rendered verbatim by all three
  shells: server-bound failures (upload/delete) read "N change(s) couldn't
  reach the server", with the most common HTTP status appended when one
  exists (ties keep the first-seen code, deterministically on every
  platform); a checkpoint failure is a LOCAL persist error — the data did
  reach the server — so it gets its own clause ("sync state couldn't be
  saved locally"), never the server wording, and is recorded at most once
  per cycle even when the interim and final persists both fail.
  413-oversize and unresolved-merge outcomes stay in `conflicts`, NOT
  `failures`. Partial cycles report honestly — a cycle can have both
  `uploaded > 0` and failures.
  → futo-notes-sync `orchestrator` (`SyncFailure`, `FailureKind`,
  `SyncSummary::failure_message`, `run_push`), sync.rs `to_wire_summary`,
  syncManager.svelte.ts (`handleSyncComplete`)
- **The failure signal also fires a toast, on message change.** A toast —
  prefixed **"Sync error: "** so the source is clear outside the sync UI
  ("Sync error: N change(s) couldn't reach the server …") — appears on the
  first failure and on
  every subsequent failure whose **message differs** (count or dominant HTTP
  status changed). An **identical** repeat stays silent — auto-sync retries a
  persistent outage every ~15s, and per-cycle toasting would spam. After a
  clear (clean sync or click-to-dismiss) the message resets, so the next
  failure toasts again. Errors are cleared **per source**: a clean completed
  sync clears cycle-failure errors but NOT a live-stream error (the stream is
  still down — clearing it would re-arm the toast and spam every reconnect
  attempt); a stream error clears when the stream reconnects or on dismiss.
  → syncManager.svelte.ts (`raiseSyncError`, `clearSyncError`,
  `SyncErrorSource`)
- **Desktop shows a persistent idle sync indicator.** While the live SSE stream
  is connected and healthy (no active sync, no error, online), the bottom-right
  corner shows a subtle ✓ tick, so "sync is set up and fine" is always legible
  rather than blank. It yields to the spinner (syncing), ⚠ (error), and
  offline icons. A failing **cycle** on a healthy stream does not drop the
  tick's connected state — the live loop reports it as `status: "cycle-error"`
  with `live: true` (only a real stream drop reports `live: false`), so one
  transient cycle error can't blank the tick until the next stream reconnect.
  Desktop only — native shells surface sync state on their Sync screen. →
  SyncStatusBar.svelte (`connected` = `sync.live`), sync.rs (`on_cycle_error`),
  futo-notes-sync `live::run_cycle`

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
- An edit made on one device appears on another device after a sync cycle.
- **Embedded images sync with their notes.** A note's `.md` and the image
  files it references (`is_image_filename`: png/jpg/jpeg/gif/webp/svg/bmp/ico/
  avif/heic) are both scanned, encrypted, and uploaded, so an `![](image-…png)`
  reference is never delivered to a peer pointing at a file that doesn't exist.
  Image binaries ride the SAME object map and note frame as text notes — their
  bytes are base64-encoded into the frame's UTF-8 `content` at read/encrypt
  time and decoded back to disk on apply — so no separate blob protocol or
  wire-format change is needed; the only cost is the base64 expansion inside
  the already-encrypted blob. Because every device mints a unique random image
  filename, two devices never produce a same-name/different-bytes image, so the
  3-way text merge is skipped for blobs (it would corrupt base64) in favor of
  the conflict-copy path, which preserves the image extension. Verified
  desktop↔desktop and into native Android (emulator, file:// vault render),
  2026-06-30. **Regression-guarded** by the `image sync roundtrip`
  cross-platform scenario (full client stack + real server: image binary
  arrives byte-for-byte AND a re-sync does not re-upload it) plus
  `orchestrator` unit tests `list_notes_skips_hidden_and_finds_md_and_images`
  and `image_blob_round_trips_through_apply_and_read` — if you re-introduce a
  `.md`-only scan/filter or a `read_to_string`/`write_atomic_text` on the blob
  path, these fail. → futo-notes-sync `orchestrator`
  (scan/`safe_relative_sync_path`/`read_local_note`/`apply_delta`),
  futo-notes-core `files::{read_blob_as_base64,write_base64_as_blob}`;
  tests/cross-platform-sync.mjs `imageSyncRoundtrip`
- The persisted sync state (`.e2ee-state.json`) is tagged with the server
  collection it describes; connecting to a **different** collection (vault
  reset, account recreation, server wipe) resets the cursor + object map and
  re-reconciles from scratch. Without this, the stale `max_version` can sit
  beyond the new collection's head and every pull silently comes back empty —
  the client never sees remote changes again (observed 2026-06-04 on all three
  clients). Untagged pre-existing state files (and legacy imports) are
  UNKNOWN provenance and reset the same way — trusting them once (the
  original behavior) re-persisted a possibly-stale cursor tagged with the new
  collection, permanently burying the corruption for exactly the cohort the
  tag was meant to heal; a stale object map is equally bad on the push side
  (entries claiming the server holds a note make the push skip it). The reset
  costs one re-reconcile through the empty-map path, which hash-dedups
  against local files. → futo-notes-sync
  `state::Loaded::reset_if_collection_changed`
- **A server instance holds exactly one vault (collection) per account.** The
  protocol is single-vault, but the server used to mint a fresh collection on
  every `POST /api/collections`, so two devices connecting *concurrently* each
  created their own vault — with its own random key — and never saw each other's
  notes (silent split-brain; reproduced 2026-06-30 via concurrent `connect()`).
  The server now enforces it: `UNIQUE(user_id)` on `collections`, an idempotent
  `POST /api/collections` (claim-or-return), and **first-write-wins** key
  material on `PUT /api/collections/:id/key` (a racing second client gets the
  authoritative key back instead of overwriting it). Pre-existing splits are
  collapsed by **migration 008** — keep the earliest vault per account (the one
  `connect()` picks), delete the rest (objects cascade). → futo-notes-server
  `collections/routes.ts`, `db/migrations/008_single_collection_per_user.ts`
- **Clients re-point to the surviving vault automatically — cold start AND while
  running.** The client adopts the authoritative key the server returns from
  `PUT …/key` (so concurrent connects converge on one key, not just one
  collection id). A client pinned to a collapsed/deleted vault heals: the server
  signals a gone vault with **404**, which the client maps to
  `SyncErrorKind::CollectionGone` (message prefixed `collection-gone:`).
  - **Cold start:** native re-picks the vault on every `connect()` (it has no
    `resume()`); desktop `resume()` surfaces `CollectionGone`, which
    `ensureConnected` catches to fall back to `connectE2ee`.
  - **Already running:** the active-session pull path (`run_pull` /
    `reconcile_empty_map`) surfaces `CollectionGone`, and the shared **live loop
    stops (terminal)** instead of spinning against the dead vault. Desktop's
    `syncE2eeAuto` catches it and re-points (`stopLiveSync` → `connectE2ee`);
    native `SyncManager` catches it — the typed `SyncError.CollectionGone` from
    `sync_now`, or the `collection-gone` string from the live loop's `on_error` —
    and re-runs `connectAndSync`.

  After re-pointing, the reset→reconcile→push re-uploads local notes to the
  survivor — no data loss for anything a device still holds. → futo-notes-sync
  `orchestrator::{connect,resume,run_pull}`, `live::watch` (terminal on
  collection-gone), `client::E2eeHttpError::is_not_found`; syncServiceE2ee
  `{ensureConnected,syncE2eeAuto}`; SyncManager.{swift,kt} `healCollectionGone`
- Moving the whole vault folder to a new location (e.g. the Android Device/App
  storage switch → [app.md](app.md) "Vault location") is transparent to sync:
  the object map is keyed by **relative** filename (not absolute path) and the
  `.e2ee-state.json` travels inside the vault, so the orchestrator picks up at
  the new root with no re-upload — provided the move carries the dotfiles.

## Live sync (SSE)

- After connecting, the client opens the server's SSE stream
  (`GET /api/sync/events`) and pulls automatically on every `ready`/`change`
  event, so a remote edit appears **without a manual "Sync now"**. The stream
  state is NOT surfaced as a "Live" label — that label was removed everywhere
  (2026-06-04): it tracked the reconnect task being alive, not an
  authenticated stream, so it stayed lit while every request 401'd. Errors
  surface via the status/lastError line instead. On desktop, the live loop's
  error emits (`sync:live-state` with a `message`) also route into the same
  ⚠ failure indicator + toast as every other sync error — previously the
  message was dropped and a failing live loop stayed quiet until the (up to
  120 s) safety poll hit the same error. The loop distinguishes its two
  failure classes: a failed **cycle** on a healthy stream emits
  `status: "cycle-error"` (`live: true` — same class as a poll failure,
  cleared by the next clean sync) while a **stream** connect/read failure
  emits `status: "reconnecting"` (`live: false`, cleared when the stream
  reconnects or on dismiss — deliberately NOT by a clean poll, which proves
  syncing works but not that the stream recovered). → futo-notes-sync
  `live::watch` (`SyncSessionListener::on_cycle_error`), `SyncClient::start_live`
  (native), `e2ee_start_live` + syncManager.svelte.ts (`handleLiveState`) +
  SyncStatusBar.svelte (desktop)
- The `change` event is a doorbell only (`{collectionId, currentVersion}`, no
  content); the client always pulls from its persisted `max_version` cursor, so
  it is robust to missed/duplicated events.
- The stream is lossy across disconnects (the server replays nothing), so the
  client also runs a ~45 s safety poll and reconnects with exponential backoff;
  a fresh `ready` drives a catch-up pull. This safety poll is also the only path
  that catches mutations the server emits no event for (collection
  create/delete, key rotation).
- The live stream is paused when the app is backgrounded and resumed on
  foreground (re-foregrounding gets a fresh `ready` → catch-up). → Android
  MainActivity `onStart`/`onStop`; iOS `FutoNotesApp` `scenePhase`
  (`SyncManager.pauseLive`/`resumeLiveAsync`).
- Live sync is wired on native **Android and iOS** — both implement the Rust FFI
  `SyncEventListener` callback over the same `start_live`/`stop_live`. → SyncScreen.kt
  (Android), SyncManager.swift + SyncView.swift (iOS)
- Live sync is also wired on **Tauri desktop** — Rust `e2ee_start_live` /
  `e2ee_stop_live` drive the same `futo-notes-sync` `live::watch`, emitting
  `sync:live-state` (tracks stream health internally via `setLiveConnected`; no
  user-facing "Live" label is rendered) and `sync:live-synced`
  (carries the per-note `SyncSummary`, which the JS routes through the normal
  `handleSyncComplete` reconciliation so the open note + list refresh live).
  `ensureLiveSync()` starts the stream after the first successful sync; the 15 s
  poll remains the fallback. → sync.rs, syncServiceE2ee.ts, syncManager.svelte.ts
- When a live pull (or the cold-launch / manual catch-up sync) brings in remote
  changes, the note list refreshes automatically so the pulled note appears
  without any user action — on **both** platforms. → `SyncManager.onLivePull` →
  `NotesStore.reload()`, wired in iOS `FutoNotesApp` and Android `MainActivity`.
  A live pull also reindexes the pulled changes into the search engine so
  synced-in notes are immediately searchable (peer changes → `change`,
  deletions → `unlink`, renames → `rename`); see [search.md](search.md).
- **Local edits auto-push on Tauri desktop AND the native shells.**
  - Desktop: a local save triggers a debounced push (`notifySavedV2` → `run_sync`),
    and the desktop live loop runs a full `run_sync` (push + pull) on each event,
    so a desktop edit propagates to peers automatically (debounce + SSE pull on the
    peer, well under a couple seconds). → autoSyncV2.ts, sync.rs `run_sync`
  - Native (iOS/Android): every `NotesStore` mutation (write/create/delete/rename/
    move/createFolder) fires `NotesStore.onLocalChange` → `SyncManager.noteChanged()`
    → the Rust `SyncClient::note_changed()` write-once auto-push signal. The live
    loop debounces and pushes the edit; peers then receive it within ~1 s via SSE.
    Fire-and-forget and a no-op when not connected. → `NotesStore.onLocalChange`
    (wired in iOS `FutoNotesApp` / Android `MainActivity`), `SyncClient::note_changed`,
    futo-notes-sync `live::watch` (debounced push branch)
- The native session (auth token + vault key) is in-memory, but **both native
  shells persist the sync password securely and auto-reconnect on a cold
  launch** (`SyncManager.restoreSession` on both), so live sync survives a
  force-quit / process death: iOS stores it in the Keychain
  (`kSecAttrAccessibleWhenUnlocked`); Android encrypts it with an Android
  Keystore AES-GCM key (alias `futo.sync`, ciphertext in SharedPreferences).
  The tradeoff is shared and deliberate: storing the password on-device means
  device compromise → password → vault key. The stored password is cleared
  on explicit disconnect (after which a relaunch stays local) and by Full
  reset. Verified on the emulator 2026-06-09: connect → `am force-stop` →
  relaunch reconnects silently (SYNCED); disconnect → relaunch stays LOCAL.
  → Keychain.swift *(iOS)*, SecureStore.kt *(Android)*

## Conflict & data safety

- A dirty-merge (local edits plus a remote change to the same note) parks the
  local edits in a `note (conflict YYYY-MM-DD).md` copy rather than discarding
  them. → futo-notes-sync orchestrator (`resolve_update_conflict`)
- Renames are paired — a rename is not seen as delete + create. → migration plan
  Phase 5
- A push checkpoint is written every 50 objects. → migration plan Phase 5
- A legacy `.app-state.json` is migrated on first run. → migration plan Phase 5
- Concurrent moves of the same note dedup to a single winner
  (`pick_duplicate_move_losers`). → migration plan Phase 5
- **Sync is push-first on every client and every trigger.** The native (iOS /
  Android) FFI `sync_now`, the SSE live loop, and the debounced auto-push all
  run the full push-first `run_sync` cycle — identical to the desktop
  orchestrator. A locally-edited-but-unpushed note is therefore PUT before any
  pull writes to disk, so a peer edit arriving via SSE can never silently
  overwrite it (the push 409 path runs the 3-way merge / conflict-copy, and the
  subsequent pull starts from the pre-push cursor so the just-pushed edit is
  never re-downloaded). The pre-fix native path ran pull-then-push, so a pulled
  peer edit clobbered the unpushed local edit on disk before push could detect
  the conflict — silent data loss, `conflicts == 0` (F1). → futo-notes-ffi
  `SyncClient::sync_now` + live `pull`/`push` closures, both calling
  `orchestrator::run_sync`; regression test
  `f1_native_sync_is_push_first_no_silent_overwrite`
- **A pure case-only / NFC-vs-NFD rename keeps its requested form.** Renaming
  `note` → `Note` (or a composed↔decomposed accent) on a
  case/normalization-insensitive filesystem (default APFS on macOS/iOS, NTFS)
  is routed through a hidden temp name (`src` → `.sf-tmp-…` → `dst`) so the
  kernel actually rewrites the stored bytes, and the false uniqueness bump
  (which used to land the rename at `Note-2.md`) is skipped. A byte-identical
  rename is still a fast no-op (F3). → futo-notes-model `crud::rename_note`
  (`collides_but_differs` + `files::rename_through_temp`); regression tests
  `case_only_rename_keeps_requested_case`, `case_only_rename_in_folder_and_move`,
  `rename_through_temp_case_only`
- **Two distinct notes whose filenames collide on a case/normalization-
  insensitive FS no longer lose a note.** On apply (both incremental `run_pull`
  and the empty-map reconcile) a path collision is detected over the UNION of
  this pull's downloads, the persisted object_map, and on-disk files sharing
  the collision key (`nfc(name).to_lowercase()`). The object with the
  lexicographically smallest `object_id` keeps the canonical name; every other
  colliding object is materialized as `name (conflict <oid8>).md`, where
  `<oid8>` is the first 8 chars of the loser's globally-unique object_id. The
  winner key (`object_id`) and the loser name are pure functions of immutable,
  globally-unique inputs that every union member carries — so resolution is
  idempotent (editing the winner can't flip it), convergent (every client mints
  the identical loser name and the fleet lands on `{canonical, name (conflict
  <oid8>)}`), and safe even when the rival is already on disk / in the map and
  is NOT in the current incremental batch (F4 same-name; F5 NFC-vs-NFD). →
  futo-notes-sync `orchestrator::resolve_pull_collisions` (used by `run_pull`
  and `reconcile_empty_map`), futo-notes-core `sync::{collision_key,
  collision_conflict_filename}`; regression tests
  `f4_same_filename_two_clients_no_note_lost`,
  `f5_nfc_nfd_collision_no_note_lost`, the `collision_*` unit tests
- **The empty-map reconcile no longer lets local silently overwrite an unseen
  remote.** When a local file diverges from a server object on a fresh empty
  map (no common ancestor ⇒ no safe 3-way merge), the remote is adopted on the
  canonical name and the local edits are parked in a deterministic `name
  (conflict <remote-oid8>).md` copy that the next push uploads as its own new
  object — instead of recording a divergence entry that the next push pushed
  over the never-reconciled remote (F6). → futo-notes-sync
  `orchestrator::reconcile_empty_map` diverged branch
- **Disconnect demotes sync state to ancestry; it never just deletes it.**
  Disconnect (all three clients) replaces `.e2ee-state.json` with
  `.e2ee-ancestry.json` — filename → {objectId, last-synced content hash} —
  and the same demotion runs when a persisted state is dropped because the
  collection identity changed. The live cursor/object map is still discarded,
  so a reconnect can never propagate while-disconnected deletions as
  fleet-wide tombstones (missing local files are re-downloaded, as before).
  → futo-notes-sync `state::demote_state_to_ancestry` /
  `state::load_for_collection`, ffi `SyncClient::disconnect`, desktop
  `e2ee_disconnect`
- **A reconnect after fleet drift does not mint conflict copies for notes the
  device never edited.** The empty-map reconcile consults the ancestry file:
  for the same objectId, local hash == last-synced hash ⇒ only the remote
  moved/renamed ⇒ fast-forward to the remote path and remove the stale local
  path (no park, no duplicate object); remote hash == last-synced hash ⇒ only
  local was edited while disconnected ⇒ keep local and push it as an update to
  the SAME object (no park, no duplicate object). Both sides changed, or no
  ancestry (fresh install, notes copied in without dotfiles) ⇒ the conservative
  F6 park above. This closes the July 2026 incident where a
  password re-login on a device that had been disconnected for days parked a
  stale `(conflict <oid8>)` copy of every note edited elsewhere in the
  meantime and synced the copies to the whole fleet. → futo-notes-sync
  `orchestrator::reconcile_empty_map` ancestry branch; regression tests
  `reconnect_after_remote_drift_fast_forwards_instead_of_parking`,
  `reconnect_after_local_edit_updates_same_object_instead_of_parking`,
  `reconnect_after_remote_rename_deletes_stale_old_path_no_duplicate`,
  `state::tests::demote_*` / `load_for_collection_*`
- `write_atomic_text` overwrites a destination that differs only in **filename
  case** from an existing file instead of failing. On case-insensitive
  filesystems (default APFS on macOS/iOS, NTFS) `fs::rename` returns EEXIST for
  a case-variant destination; before the fix one colliding note aborted the
  *entire* sync apply mid-download. The recovery PARKS the colliding entry as
  a hidden `.sf-bak-…` file (restored if the retry fails, deleted on success)
  rather than deleting it first — a crash mid-recovery leaves the old bytes
  recoverable on disk instead of losing them. → futo-notes-core `files.rs`
  (`park_case_variants` + retry; regression test
  `write_atomic_text_overwrites_case_variant`)

- A save may only persist content read from a **live** editor view. The
  desktop editor's `getContent()` returns `undefined` (never `''`) when the
  CM6 view is destroyed or not yet mounted, and every save path treats
  `undefined` as "no editor — skip". An empty string from a dead view is
  indistinguishable from "the user deleted everything": a stale flush firing
  against a torn-down editor saved `''` over the open note and sync
  propagated the truncation to every connected device (observed 2026-06-04
  via a dev HMR swap; the same teardown race exists on note-switch/quit).
  → editorContentSync `readDocContent`, MarkdownEditor `getContent`

- A note's modified time is **server-authoritative** so note-list ordering is
  identical on every device: a real push restamps the local file to the
  server's `updated_at`, every pull/download stamps it, and a
  content-identical local touch (editor re-save, relink rewrite, `touch`) is
  corrected back to the recorded server timestamp on the next sync rather
  than adopted. The empty-map reconcile likewise converges matching-content
  files to the server timestamp. (Observed 2026-06-05: a content-identical
  rewrite on the Mac left `Markdown demo` sorted minutes newer than on
  Android/iOS.) → futo-notes-sync orchestrator (`push_one_file` StampOnly
  short-circuit, `reconcile_empty_map`); regression tests
  `touch_without_content_change_restores_server_mtime`,
  `reconcile_identical_content_converges_mtime_to_server`

- **Closed (2026-06-05):** reconciliation of two *distinct* notes whose
  filenames collide only by case (`welcome.md` vs `Welcome.md`) or by Unicode
  normalization (NFC vs NFD) on a case/normalization-insensitive FS no longer
  double-tombstones or loses a note. The original failure (observed 2026-06-04,
  mac ↔ iOS sim ↔ Android emu: the rename/hash reconciliation tombstoned
  **both** objects, deleting the note from every client) is replaced by the
  deterministic conflict-copy policy above: winner = smallest `object_id` keeps
  the canonical name, every other colliding object is materialized at `name
  (conflict <oid8>).md`. The collision detector ranks the union of the current
  pull batch, the persisted object_map, and on-disk files, so the rival being
  already-present (not in the incremental batch) is handled — the exact
  double-tombstone path is gone. → futo-notes-sync
  `orchestrator::resolve_pull_collisions`; F4/F5 regression tests.

## Polling

- Desktop auto-sync poll interval is intentionally short (the SSE live stream is
  the push replacement; the poll remains the desktop fallback) — don't lengthen
  it. → project decision
- Native shells do not run a foreground poll loop; the SSE live stream plus its
  ~45 s safety poll cover liveness (see "Live sync (SSE)"). → futo-notes-sync
  `live::watch`

- A remote edit to the **currently-open note** is adopted into the open editor
  when the local draft is clean (`content == savedContent`); a dirty draft
  still wins and is never overwritten. Without this, the open editor kept
  showing a stale base and — worse — SAVED IT BACK on exit, silently
  clobbering the remote edit (observed 2026-06-04). → NoteEditorView.swift
  (`onReceive(store.$notes)`), NoteEditorScreen.kt (`snapshotFlow
  { store.notes }`)
- The desktop adopt works for **every consecutive** remote edit, not just the
  first. The adopt's own programmatic `setEditorContent` echoes back through
  the editor's rAF-coalesced `onchange` one frame later — after the
  synchronous `suppressSaveOnChange` window has closed — and used to count as
  a user edit (`editVersion++`), which made `handleSyncComplete`'s
  edited-during-sync gate silently skip every subsequent adopt until the note
  was reopened (observed 2026-06-04: iPhone edit #1 appeared in the open mac
  editor, edit #2 never did). Echo deliveries (content identical to both the
  session and saved content) are now dropped before the edit bookkeeping, and
  the adopt gate additionally checks `hasOpenDraftChanges()` (a synchronous
  live-doc read) so a keystroke whose rAF delivery is still in flight can
  never be clobbered by the adopt. → noteSession `isEditorChangeEcho`,
  syncManager `handleSyncComplete`

- The native clean-adopt **preserves the caret/selection and scroll**: the
  shells push remote content through the embed's `applyExternalContent`
  (bridge v2), which applies a minimal diff with history suppressed — the
  same editorContentSync path as the desktop's `applyExternalContent` —
  instead of the full-replacement `setContent`. Works for consecutive remote
  edits. Verified cross-device (simulator ↔ emulator) 2026-06-09: with the
  caret parked mid-document, a peer edit appeared in the open editor and the
  selection/caret held on both platforms. → packages/editor bridge v2,
  NoteEditorScreen.kt / NoteEditorView.swift
- A **dirty draft against a real remote change** (draft still inside the
  save debounce when the pull rewrites the file) is parked, not kept: the
  pending save is cancelled, the draft is written to a
  `<title> (conflict YYYY-MM-DD)` copy (uniqued like every create), the
  remote content is adopted into the editor, and a "Conflicting edits saved
  to a copy" toast fires. A draft that already reached disk is covered by
  the push-first 409 machinery above instead. Verified on the emulator
  2026-06-09 (held-dirty draft + peer edit → copy contained the draft,
  editor showed the remote). → NoteEditorScreen.kt / NoteEditorView.swift
