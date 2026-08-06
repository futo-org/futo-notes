# Sync — Spec

E2EE sync. **All sync logic lives in the Rust `futo-notes-sync` crate**; every
shell only drives it. Native (iOS/Android) goes through the `futo-notes-ffi`
`SyncClient`; Tauri desktop goes through the `e2ee_*` Tauri commands (a thin
`apps/tauri/src-tauri/src/sync/tauri_commands.rs` wrapper) +
`syncServiceE2ee` + coordinator — both now drive the **same** `SyncSession`.
The session owns connection state, push-first cycles, and its live task; the
shells do not assemble those pieces themselves. Internally the crate is grouped
by ownership: `server/` owns the HTTP protocol; `checkpoint.rs` owns persisted
state and disconnect ancestry; `session/` owns connection lifecycle, cycle
serialization, live scheduling, and SSE framing; `sync/` owns the visible
push-first sequence and delegates vault I/O, push, pull, conflict resolution,
collision resolution, tombstones, encrypted-note conversion, transfer chunking,
batch download, and outcome composition to named modules. The client uploads
opaque encrypted blobs — note
content is encrypted before upload. Desktop sync module ownership and
serialization boundaries are fixed by [desktop-rust.md](desktop-rust.md).

## Connect / run

- Connecting requires a server URL + password; a successful connect auto-runs a
  first sync. → SyncScreen.kt
- Once connected, the server URL is locked. The user can "Sync now" or
  "Disconnect" (desktop labels the disconnect **Reset connection** and asks
  for confirmation; a separate **Forget password** drops only the stored
  keyring entry, keeping the connection). → SyncScreen.kt,
  SyncSettingsSection.svelte
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
  message. → syncErrorMessage.ts (`getSyncErrorMessage`),
  syncManager.svelte.ts (`syncError`, `clearSyncError`), SyncStatusBar.svelte
  (`onclear`), SettingsScreen.svelte (desktop)
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
  signal for days. **The user-facing message is computed ONCE, in the Rust
  core** (`SyncSummary::failure_message`) and rendered verbatim by all three
  shells: server-bound failures (upload/delete) read "N change(s) couldn't
  reach the server", with the most common HTTP status appended when one
  exists (ties keep the first-seen code, deterministically on every
  platform); pull-side download failures read "N note(s) couldn't be
  downloaded (will retry)" — the retry promise is real, see the cursor-cap
  bullet below; decrypt failures read "N note(s) couldn't be decrypted",
  kept out of the network wording because they indicate key material or
  corruption, not connectivity; a checkpoint failure is a LOCAL persist
  error — the data did
  reach the server — so it gets its own clause ("sync state couldn't be
  saved locally"), never the server wording, and is recorded at most once
  per cycle even when the interim and final persists both fail.
  413-oversize and unresolved-merge outcomes stay in `conflicts`, NOT
  `failures`. Partial cycles report honestly — a cycle can have both
  `uploaded > 0` and failures.
  → futo-notes-sync (`SyncFailure`, `FailureKind`,
  `SyncSummary::failure_message`, push/pull cycle),
  `apps/tauri/src-tauri/src/sync/frontend_contract.rs` `SyncSummary::from`,
  syncManager.svelte.ts
  (`handleSyncComplete`)
- **A failed blob download never advances the cursor past the object.** The
  `max_version` persisted by a pull (including the bootstrap pull from cursor
  0) is capped below the lowest failed `change_seq`, so the next cycle re-lists
  and retries the failed object — re-listing already-landed objects is
  idempotent (the object-map version check in `first_pass` skips them).
  Without the cap, an object whose blob failed to download or decrypt was
  skipped silently and permanently (never re-listed via `sinceVersion`) —
  data loss on receive unless the object was edited again server-side. The
  cap wins over the cycle's incoming cursor — push advances `max_version`
  for its own uploads before the pull runs, and merging instead of
  overwriting would re-skip a failed object whenever the same cycle pushed
  anything. A permanently poisoned blob (decrypt failure) therefore pins the
  cursor and is re-attempted every cycle by design — the blob re-downloads
  in full and re-fails each cycle (deliberate: a later server-side repair or
  key fix is picked up without new state) — with the ⚠ failure line keeping
  the user informed.
  → futo-notes-sync `sync/pull/` (`cap_cursor`, pull/reconcile)
- **Pull batches small blob downloads; a 1-file sync stays on the classic
  path.** The download stage, used by incremental pull and empty-map reconcile,
  bin-packs pending blobs smallest-first from listing `size_bytes` into
  `POST /api/blobs/batch` requests of ≤8 MiB / ≤100 keys, with up to 4 requests
  in flight. Blobs ≥8 MiB, unknown-size objects, and singletons use the classic
  per-blob GET in an 8-concurrent pool. Known-size transfer timeouts are 30
  seconds plus the expected bytes at 128 KiB/s; unknown-size classic downloads
  use the same 30-second baseline. Objects
  already current in the local map are filtered before download scheduling, so
  a cursor-zero heal or pinned-cursor re-list does not redownload the vault.
  A failed batch retries twice (0.5 s / 2 s),
  then degrades to classic GETs; non-retryable 4xx responses degrade
  immediately, and a batch-route 404/405/501 disables batching for the rest of
  that pull. Malformed responses use the same retry/degrade path. `missing` is
  reported like a classic 404, while `omitted` entries are re-requested up to
  three times before classic fallback. Each bounded completion is applied and
  atomically checkpointed before another completion is awaited, while the
  persisted pull cursor remains at its previous value; a crash therefore
  safely relists instead of pairing changed files with stale object-map state.
  The final checkpoint advances the cursor only after all transfers finish,
  retaining the cursor-cap behavior for per-object failures. Pull progress has
  one owner: it starts at zero and advances once per completed blob.
  → futo-notes-sync `server/` (frozen HTTP framing),
  `sync/transfer/{download_executor,http_transport}/`, `sync/chunking.rs`,
  and `sync/pull/`; guarded by
  `batch_blob_frames_decode_all_statuses_and_reject_malformed_bodies`,
  `batch_blob_frames_reject_illegal_status_payload_combinations`,
  `transfer_timeout_scales_with_expected_bytes`,
  `pull_skips_current_objects_before_download`,
  `completed_batch_is_applied_and_checkpointed_before_a_slow_single_finishes`,
  and F-series `f_batch_download_first_sync`; server: futo-notes-server
  `src/blobs/routes.ts` (`POST /api/blobs/batch`)
- **Push batches small encrypted blob creates and updates; a 1-file push stays
  on the classic path.** Pending ciphertext is ordered smallest-first and packed
  into `POST /api/collections/:id/blob-objects/batch` requests of ≤8 MiB / ≤100
  entries, with up to 4 requests in flight. Ciphertexts ≥8 MiB and singletons
  use the classic create/update endpoints. A failed batch retries twice (0.5 s
  / 2 s), then degrades its entries to classic requests; non-retryable 4xx
  responses degrade immediately, and a batch-route 404/405/501 disables
  batching for the rest of that push. Per-entry create, update, conflict, not-found,
  too-large, and server-error outcomes feed the existing conflict/failure
  handling. Each completed chunk is applied and checkpointed before another
  completion is awaited. If a file changes while its older ciphertext is in
  flight — including before a replay response or during its second, successor
  request — replay reconciliation first ensures that the in-flight candidate
  bytes reached the server, then records the newer disk edit as dirty for the
  next cycle. Batch success responses are
  accepted only when each status is compatible with its request and each
  returned update object ID matches its request, preventing a reordered or
  malformed response from corrupting the map. Creates adopt the server-generated
  object ID returned for their Mutation ID. Every create has one client-generated
  Mutation ID stored in `.e2ee-state.json` before any
  batch or classic request can leave. Batch retries, classic fallback, direct
  tombstone re-creates, and application-restart retries reuse that Mutation ID until
  the successful object mapping is durably settled. `created`, `replayed`, and
  `updated` remain distinct through the HTTP adapter: a replay proves the mutation
  exists but does not prove that newer retry bytes landed. An unchanged replay
  records the returned object version and blob as its guarded baseline; newer
  local bytes are sent as a version-guarded successor update. If the successor
  conflicts after the file changes again, the client keeps the pending identity
  and stops before conflict resolution or pull can overwrite the newest disk
  bytes. Conflict-resolution writes and conflict-copy creation recheck the
  candidate hash inside the vault mutation guard; an edit made during remote
  fetch, merge, or conflict-copy upload therefore remains dirty instead of being
  replaced by stale merge inputs. Renamed conflict targets must also remain
  absent under that guard, so an unrelated destination note is never
  overwritten; if only the destination is occupied, the resolved content stays
  at the guarded source path so the cycle settles instead of retrying the same
  rename forever. Delete-conflict recovery likewise distinguishes a recreated
  source from an occupied destination: a note recreated during the blob fetch
  stays dirty, while an occupied destination preserves both notes by restoring
  the peer winner at the original deleted path. Conflict copies created before a guarded
  adoption abort still count as local writes so native shells reload them. A
  local deletion during a live replay keeps the returned version so the
  next push can issue a valid guarded delete. A local deletion during an already
  tombstoned replay clears the pending identity because both sides have reached
  the requested absent state. If the file remains, the spent tombstoned identity
  is discarded and checkpointed; the normal next push mints and persists the
  replacement immediately before dispatch, avoiding a never-sent pending ID.
  Checkpoints written by the earlier replay implementation with synthetic
  version `0` verify the object still exists, then delete against the conservative
  create baseline version `1`; a peer edit therefore produces the normal `409`
  edit-wins recovery instead of being claimed by the deletion. Restart recovery rebinds a
  pending create only to one same-basename/same-hash file, blocks ambiguous
  matches, excludes pending-create files from ordinary rename inference, and
  reconciles a locally deleted pending create through the server's durable
  create-mutation outcome. A found outcome adopts the server object; `409`
  means the original create is still staging, so the client retains its pending
  state and stops before pull; `404` proves the create never committed, so the
  client discards the pending entry and continues syncing. The server providing
  durable successful-create outcomes must be deployed before this client. A pending-only
  restart skips bootstrap pull so recovery and its successor update run first.
  The pending field is additive: old checkpoints load with an empty map and
  older clients ignore it. Apart from durable pending-create recovery, new clients
  remain functional with older servers:
  a missing batch route falls back to classic, a classic-create response that
  omits `replayed` is treated as replay-uncertain, and the server-returned object
  ID always wins. An unchanged uncertain create keeps the server-returned
  version; if the local file has newer bytes, they are sent as a version-guarded
  successor update instead of being falsely marked synced. A pre-Mutation-ID server ignores
  `Mutation-Id`, so exactly-once recovery after an ambiguous classic response
  still requires the upgraded server. Released older clients omit the header;
  an upgraded server treats those creates as independent mutations, preserving
  each successful retry body while retaining the legacy duplicate-object risk.
  → futo-notes-sync `server/` (frozen HTTP framing),
  `sync/transfer/{upload_executor,http_transport}/`, `sync/chunking.rs`,
  `sync/transfer_retry.rs`, and `sync/push/`;
  guarded by `upload_batch_frames_encode_the_frozen_wire_contract`,
  `classic_create_sends_the_mutation_id_and_accepts_server_generated_object_ids`,
  `validation_accepts_server_generated_create_ids_but_rejects_wrong_update_ids`,
  `validation_rejects_each_status_incompatible_with_the_operation`,
  `create_identity_is_checkpointed_before_a_classic_request`,
  `pending_create_restart_pushes_before_any_pull`,
  `restart_after_a_lost_create_checkpoint_replays_without_a_new_identity`,
  `restart_discards_a_replayed_tombstone_identity_before_retrying`,
  `legacy_create_response_with_newer_local_bytes_is_followed_by_an_update`,
  `edit_before_replay_response_still_runs_the_successor_update`,
  `edit_during_replay_successor_remains_dirty_for_the_next_push`,
  `replay_successor_conflict_does_not_merge_over_a_newer_disk_edit`,
  `edit_during_replay_conflict_resolution_is_not_overwritten`,
  `deletion_before_a_live_replay_response_keeps_the_server_version`,
  `deletion_before_a_tombstoned_replay_response_clears_the_create_identity`,
  `deleted_legacy_replay_placeholder_fetches_the_created_object_before_delete`,
  `deleted_legacy_replay_placeholder_does_not_claim_a_peer_edit`,
  `recreated_note_during_delete_conflict_recovery_is_not_overwritten`,
  `occupied_delete_conflict_rename_uses_the_original_path`,
  `occupied_remote_rename_falls_back_to_the_source_path`,
  `guarded_replacement_does_not_overwrite_an_existing_target`,
  `never_committed_pending_create_is_cleared_before_pull`,
  `in_progress_pending_create_stops_before_pull_and_remains_pending`,
  `restart_drops_pending_create_the_server_never_committed`,
  `rename_detection_does_not_claim_a_pending_create_file`,
  `legacy_server_fallback_accepts_server_generated_create_ids`,
  `two_new_notes_use_one_batch_upload_request`,
  `completed_batch_chunk_is_checkpointed_before_a_later_chunk_finishes`, and
  `completed_stale_upload_leaves_a_newer_local_edit_dirty`;
  pull cannot overwrite failed or newly edited local bytes, guarded by
  `failed_mapped_upload_does_not_allow_pull_to_overwrite_the_dirty_path` and
  `replay_hydration_rechecks_the_local_revision_before_writing`; F-series
  `f_batch_upload_first_push`; server: futo-notes-server
  `src/objects/batch-upload/`
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
  → syncManager.svelte.ts (`raiseError`, `clearError`)
- **Desktop shows a persistent idle sync indicator.** While the live SSE stream
  is connected and healthy (no active sync, no error, online), the bottom-right
  corner shows a subtle ✓ tick, so "sync is set up and fine" is always legible
  rather than blank. It yields to the spinner (syncing), ⚠ (error), and
  offline icons. A failing **cycle** on a healthy stream does not drop the
  tick's connected state — the live loop reports it as `status: "cycle-error"`
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
  arrives byte-for-byte AND a re-sync does not re-upload it). If you
  re-introduce a `.md`-only scan/filter or a text-only read/write on the blob
  path, that scenario fails. → futo-notes-sync sync module,
  futo-notes-core `files::{read_blob_as_base64,write_base64_as_blob}`;
  tests/cross-platform-sync.mjs `imageSyncRoundtrip`
- **The image set has ONE definition (canonical 10: png/jpg/jpeg/gif/webp/svg/
  bmp/ico/avif/heic).** Sync classifies blob-vs-note with
  `futo_notes_core::image::{is_image_filename,is_syncable_filename}` — the same
  set `futo-notes-model` and `@futo-notes/editor` expose, conformance-locked by
  `tests/conformance/image.json`; native pickers receive it through
  `futo-notes-ffi::image_extensions`. (Historically `core::invariants` kept an
  independent 13-entry copy with `.tiff/.tif/.heif`; D4 unified them.) →
  futo-notes-core `image.rs`; tests/conformance/image.json
- **Legacy image blobs (pre-D4 `.tiff/.tif/.heif`, or any non-syncable
  extension) are left untouched, never destroyed or mis-materialized.** The
  shared incoming pull path (`pull::pull_with_checkpoint`, including bootstrap
  with `since = 0`) ignores such a server object — never write it as a note,
  never map it, never count it, never tombstone it, never error the cycle; a
  push never tombstones a non-syncable map entry (the local scan no longer
  surfaces it, so without the guard it would look "deleted locally" and be
  erased on the server and every peer). → futo-notes-sync sync module
- **Every incoming name is screened before it is written, and a name local
  creation legitimately produces is HEALED rather than dropped.** A single
  classifier (`classify_incoming_sync_path`) runs before collision planning for
  both the shared pull path (`pull::pull_with_checkpoint`, including bootstrap
  with `since = 0`) and the edit-wins delete restore:
  (a) a Windows-reserved device name (`CON`), a leading/
  trailing dot, or a trailing space — all of which macOS/Linux creation
  produces but Windows cannot hold — is HEALED to the same safe name
  `sanitize_title` would mint (`CON`→`CON_`, `.env`→`env`, `note.`→`note`),
  written under that name, and NOT reported as a failure (the note is never
  lost); (b) a name that is genuinely unsafe or physically impossible —
  traversal, a component past `NAME_MAX`, excess depth — is
  REJECTED: skipped, never written, surfaced as a permanent `rejected` failure
  (not the retryable `download`), never cursor-capped, never aborting the cycle;
  (c) a name no portable filesystem can hold — one containing `< > : " | ? *` or
  a control character, which macOS/Linux hold happily and Windows cannot — is
  IGNORED: skipped, never written, and deliberately NOT a failure. Such a name
  cannot escape the vault, so refusing it is a portability decision, not a
  safety one; the file is left strictly alone on whichever devices already hold
  it. The only trace is a local journal decision (`ignored` /
  `unportable_incoming_name`), never a user-facing message.
  The traversal screen runs on the HEALED component as well as the raw one, so a
  name whose heal would itself become `.` or `..` (`". .. ./note.md"` heals to
  `"../note.md"`) is rejected rather than written outside the vault. The heal is
  deterministic, so two clients pick the same safe name. The ONLY
  length rejection is the filesystem's `NAME_MAX` (255 bytes) — the UI title
  budget (`MAX_TITLE_LENGTH`) is deliberately NOT enforced here, so a valid
  201–251-byte file a peer legitimately holds still syncs (the boundary stays
  no stricter than production). → futo-notes-core
  `files::classify_incoming_sync_path` (+ `sanitize_title`,
  `is_windows_reserved_name`, `NAME_MAX`), applied via
  futo-notes-sync sync module; guarded by the core `incoming_*` tests and the
  `incoming_components_that_heal_into_a_traversal_are_rejected` +
  `healed_incoming_paths_are_traversal_free` properties in
  `crates/futo-notes-core/src/files/paths.rs`, plus
  `an_unportable_remote_name_is_ignored_without_a_failure`
- **A local file whose name no portable filesystem can hold is never uploaded,
  and never mistaken for a deletion.** The same classifier screens the push
  side, so one rule answers portability in both directions: the file is dropped
  from the upload list and journaled (`ignored` / `unportable_local_name`), with
  no failure and no user-facing signal. It MUST remain in the local scan
  (`local_files`) while it is dropped, because `missing_local_files` reads "in
  the object map, absent from the local scan" as a local delete — filtering it
  out of the scan instead would tombstone the note on the server and every peer.
  A copy uploaded by an older client (push never validated names) is left on the
  server as-is and simply stops receiving updates; it is never deleted. These
  files are also absent from the note list on every shell, because the local
  note scan has always skipped them — the app leaves them strictly alone.
  → futo-notes-sync `sync/push/mod.rs` `uploadable_files`; guarded by
  `an_unportable_name_is_never_uploaded_and_is_journaled_not_failed` +
  `an_unportable_name_is_not_mistaken_for_a_local_delete`
  > **Gap:** The heal is not idempotent for a name ending in repeated `". "`
  > groups — `sanitize_title` peels exactly one group per pass, so `"a. ..md"`
  > heals to `"a..md"`, which the next cycle heals again to `"a.md"`: one rename
  > per sync round until it settles. Closing it means changing the title rule in
  > both `packages/editor/src/filename.ts` and `futo-notes-core` plus regenerated
  > conformance fixtures (AGENTS.md M7); the invariant is recorded as the
  > `#[ignore]`d `healing_an_incoming_path_settles_in_one_round` property.
- **A healed incoming name is a LOCAL alias, not pushed back to the server.**
  The healing client writes + maps the object under the safe name but does not
  re-upload it, so the server object keeps its original path until someone edits
  it. Until every client runs the healing version, one object can therefore
  display under different names across the fleet (e.g. `CON.md` on an old client,
  `CON_.md` on a healed one) — the CONTENT still converges (same object id, same
  bytes) and no duplicate is created; only the displayed filename differs. →
  futo-notes-sync sync module
- The persisted sync state (`.e2ee-state.json`) is tagged with the server
  collection it describes; connecting to a **different** collection (vault
  reset, account recreation, server wipe) resets the cursor + object map and
  re-reconciles from scratch. Without this, the stale `max_version` can sit
  beyond the new collection's head and every pull silently comes back empty —
  the client never sees remote changes again (observed 2026-06-04 on all three
  clients). Untagged pre-existing `.e2ee-state.json` files are UNKNOWN
  provenance and reset the same way — trusting them once (the
  original behavior) re-persisted a possibly-stale cursor tagged with the new
  collection, permanently burying the corruption for exactly the cohort the
  tag was meant to heal; a stale object map is equally bad on the push side
  (entries claiming the server holds a note make the push skip it). The reset
  costs one bootstrap pull from cursor 0, which hash-dedups
  against local files. → futo-notes-sync `checkpoint.rs`
- The one-time legacy import of a pre-port `.app-state.json` object map is
  TAGGED with the vault's `e2eeCollectionId` (written next to the map in the
  same file), so reconnecting to that same collection KEEPS the imported map
  instead of resetting it — a note edited offline before the port lands as a
  clean update to its existing object (same object_id, PUT at the next
  version) rather than a conflict copy or a re-POSTed duplicate. Importing
  then connecting to a *different* collection still resets, and an older
  pre-port file that predates `e2eeCollectionId` carries no tag and resets as
  UNKNOWN provenance (the bootstrap pull from cursor 0 then hash-dedups). →
  futo-notes-sync `checkpoint.rs`
- **Clients use one canonical vault (collection) per account even though the
  server preserves plural collection rows.** The server must retain every
  pre-existing collection during upgrades — deleting extras would destroy
  opaque user data — so `POST /api/collections` may create independent rows.
  On connect, the client selects the earliest collection (creation time, then
  id); when the list is empty it creates a row and then **re-lists before
  claiming key material**. Two devices connecting concurrently therefore both
  converge on the earliest row instead of each claiming the row its own POST
  returned. Key material remains first-write-wins: a racing `PUT …/key` 409
  makes the loser fetch and adopt the authoritative key. Extra empty rows from
  a setup race remain harmless and are never selected while an earlier vault
  exists. This prevents the silent split-brain reproduced by
  `concurrent_connect_converges_to_one_vault` without a destructive server
  migration. → futo-notes-sync `session/connect.rs`; futo-notes-server
  `collections/routes.ts`, `db/migrations/009_restore_plural_collections.ts`
- **Clients re-point to the surviving vault automatically — cold start AND while
  running.** The client adopts the authoritative key the server returns from
  `PUT …/key` (so concurrent connects converge on one key, not just one
  collection id). A client pinned to a collapsed/deleted vault heals: the server
  signals a gone vault with **404**, which the client maps to
  `SyncErrorKind::CollectionGone` (message prefixed `collection-gone:`).
  - **Cold start:** native re-picks the vault on every `connect()` (it has no
    `resume()`); desktop `resume()` surfaces `CollectionGone`, which
    `ensureConnected` catches to fall back to `connectE2ee`.
  - **Already running:** the active-session pull path
    (`pull::pull_with_checkpoint`, including bootstrap with `since = 0`) surfaces
    `CollectionGone`, and the shared **live loop
    stops (terminal)** instead of spinning against the dead vault. Desktop's
    `syncE2eeAuto` catches it and re-points (`stopLiveSync` → `connectE2ee`);
    native `SyncManager` catches it — the typed `SyncError.CollectionGone` from
    `sync_now`, or the `collection-gone` string from the live loop's `on_error` —
    and re-runs `connectAndSync`.

  After re-pointing, the reset→reconcile→push re-uploads local notes to the
  survivor — no data loss for anything a device still holds. → futo-notes-sync
  `SyncSession` (terminal live error on collection-gone); syncServiceE2ee
  `{ensureConnected,syncE2eeAuto}`; SyncManager.{swift,kt} `healSession`
- Moving the whole vault folder to a new location (e.g. the Android Device/App
  storage switch → [app.md](app.md) "Vault location") is transparent to sync:
  the object map is keyed by **relative** filename (not absolute path) and the
  `.e2ee-state.json` travels inside the vault, so the session picks up at
  the new root with no re-upload — provided the move carries the dotfiles.
  Android storage migration synchronously closes a session-operation gate, then
  drains credential restore/heal, connect, manual sync, and live-resume work
  before gracefully cancelling and joining the live task and awaiting the Rust
  session's cycle gate. It never aborts an in-flight cycle before that cycle
  installs its advanced in-memory/checkpoint state. It then takes the store's
  exclusive vault gate, so sync/editor/store/image writes cannot race the staged
  copy and manifest verification. →
  `SyncSession::stop_live_and_wait`, `SyncManager.quiesceForStorageMigration`,
  `NotesStore.migrateVault`, Android `storage/StorageMigrationGateTest`

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
  `session/` (`SyncSessionListener::on_error`), `SyncClient::start_live`
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
- Live sync is wired on native **Android and iOS** — both implement the Rust FFI
  `SyncEventListener` callback over the same `start_live`/`stop_live`. → SyncScreen.kt
  (Android), SyncManager.swift + SyncView.swift (iOS)
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
  any user action — on **both** platforms. → `SyncManager.onLivePull` →
  `NotesStore.reload()`, wired in iOS `FutoNotesApp` and Android `MainActivity`.
  A live pull also reindexes the pulled changes into the search engine so
  synced-in notes are immediately searchable (peer changes → `change`,
  deletions → `unlink`, renames → `rename`); see [search.md](search.md).
  - The reload fires on the core-computed `SyncSummary.localWritesApplied`, not
    only `downloaded`/`deleted` — a **push-side** clean merge (`MergedClean`)
    writes merged text to local disk while reporting `uploaded`, so gating on
    downloads/deletes alone let a stale open native editor's next autosave
    clobber the peer's merged-in edit (F2). → `SyncManager.wroteLocalChanges`
    (iOS/Android), guarded by `SyncManagerReloadGateTest` (Android) +
    `combine_summaries_carries_local_writes_applied` (core).
- **Local edits auto-push on Tauri desktop AND the native shells.**
  - Desktop: a local save triggers a debounced push (`notifySavedV2` → `run_sync`),
    and the desktop live loop runs a full `run_sync` (push + pull) on each event,
    so a desktop edit propagates to peers automatically (debounce + SSE pull on the
    peer, well under a couple seconds). → autoSyncV2.ts,
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
  re-enter it on demand. A failed keyring *delete* on disconnect/forget/Full
  reset surfaces a toast and sets a non-secret `pendingKeyringDeletion` marker
  in `.app-state.json` that the next launch retries. The tradeoff is shared and
  deliberate:
  storing the password on-device means device compromise → password → vault key.
  The stored password is cleared on explicit disconnect (after which a relaunch
  stays local) and by Full reset (desktop `resetAllNotes` → `disconnectE2ee`
  deletes the keyring entry, M4). Verified on the emulator 2026-06-09: connect →
  `am force-stop` → relaunch reconnects silently (SYNCED); disconnect → relaunch
  stays LOCAL.
  On web (non-Tauri, not a shipping sync surface) there is no OS keyring, so the
  password is held in memory only and is deliberately not persisted across a
  page reload.
  → Keychain.swift *(iOS)*, SecureStore.kt *(Android)*,
  sync/password_store.rs + syncServiceE2ee.ts *(desktop)*
- **An expired server bearer session reauthenticates transparently from the
  securely saved password without resetting sync state.** Server bearer tokens
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

## Conflict & data safety

- A dirty-merge (local edits plus a remote change to the same note) parks the
  local edits in a `note (conflict YYYY-MM-DD).md` copy rather than discarding
  them. → futo-notes-sync sync module
- **A local edit to a note a peer deleted is preserved, not discarded.** When a
  dirty local edit is pushed but the server object was tombstoned by a peer, the
  edit is re-POSTed as a fresh LIVE object at its own filename instead of being
  dropped. The server's DELETE keeps the object's blob_key and bumps its version,
  so the push PUT 409s with a blob present (not `None`) and the 3-way merge
  re-PUT "succeeds" — but the row is still `deleted: true` (a PUT does not
  un-delete). Mapping the note to that tombstone would let the same cycle's pull
  immediate-delete erase the merged edit. The resolver reads the `deleted` flag
  on the re-PUT response and, when set, re-POSTs the content as a fresh object;
  it also handles the degenerate `current_blob_key: None` shape the same way.
  Re-mapping the filename to the new object stops the tombstone (old object id)
  from matching any local file, so the pull cannot re-delete it, and the edit
  propagates back to the peer. Symmetric with the edit-wins delete-conflict (a
  peer edit to a note WE delete keeps the peer edit). The old code returned an
  `UnresolvedConflict` that wrote nothing / mapped the note to the tombstone, and
  the edit was silently lost. (F3) → futo-notes-sync sync module;
  cross-platform scenario "edit vs peer delete preserves edit"
- A direct PUT that "succeeds" onto a still-deleted server row (the server's
  DELETE bumps the version, so a concurrent editor's expected-version can
  collide and no 409 fires) is detected via the response's `deleted` flag and
  the edit is re-POSTed as a fresh live object — never mapped to the tombstone
  where the puller's own pull would delete it. → futo-notes-sync sync module
- Pull-side filename collisions between byte-identical objects adopt silently
  (smallest object id stays canonical; the identical loser mints NO
  `(conflict <oid8>)` copy and its map entry is dropped without tombstoning
  the live server object) — only genuinely divergent content is parked. →
  futo-notes-sync sync module
- Renames are paired — a rename is not seen as delete + create. → migration plan
  Phase 5
- **Sync reports rename intent; shells never infer renames from id patterns.**
  Every relocation the sync engine performs — paired local moves, mapping
  relocations, merge-target moves, and collision placements that relocate a
  locally-mapped note (the loser's move to `name (conflict <oid8>)`) — is
  reported in the locally-computed `SyncSummary.renamed` (no sync payload or
  protocol change; a byte-identical collision loser adopts silently and
  reports no rename). The desktop follows the open tab/editor through a
  reported rename verbatim; its former id-pattern inference
  (`findActiveSyncRename` / `isCollisionVariantId`) is deleted. →
  futo-notes-sync `sync/collision_resolution.rs` (guarded by
  `collision_placement_reports_the_relocated_local_note_as_a_rename` and
  `identical_content_collision_dedup_reports_no_rename` in
  `sync/behavior_tests.rs`); desktop `reconcileSyncCompletion.ts` (guarded by
  "follows a reported collision-placement rename before pruning deletions" in
  src/features/sync/syncManager.test.ts and the cross-platform scenario
  "collision placement follows open note" in tests/cross-platform-sync.mjs)
- **Every shell family is handed the same cycle report.** The desktop IPC
  contract and the UniFFI contract both project the engine summary losslessly —
  the four counters plus `updatedIds`, `deletedIds`, `peerUpdatedIds`,
  `peerDeletedIds` and the reported `renamed` pairs — so no shell has to
  re-derive what changed from counts (ADR-0001). Each projection destructures a
  fully populated engine summary in its own test, so a new engine field cannot
  reach one shell family while silently skipping the other. →
  apps/tauri/src-tauri/src/sync/frontend_contract.rs and
  crates/futo-notes-ffi/src/sync/contract.rs (both guarded by
  `projection_carries_every_engine_field`)
  > **Gap:** The native shells receive the per-id delta but do not yet act on
  > it: `onLivePull` is a zero-argument callback, so iOS and Android still
  > rescan the whole vault after every cycle and never follow a reported
  > rename. An open note that sync relocates reads as a peer delete on iOS
  > ("Note was deleted during sync") and strands the Android editor on the old
  > id. Scoping the list refresh additionally needs a per-id metadata verb; the
  > engine exposes only whole-vault `scan()` today.
- **A rename never hides a real update OR deletion of its target.** Summary
  ghost-stripping removes only the rename's from-side from
  `deletedIds`/`peerDeletedIds` (the "delete at the old name" byproduct every
  relocation records); nothing is recorded against the target side, so an id
  recorded there — an update OR a deletion — is always a real, subsequent
  same-cycle event and stays shell-visible. A same-cycle peer edit to a
  collision-relocated note keeps its entry in `updatedIds`/`peerUpdatedIds`, so
  the shell that followed the rename reloads the peer's content instead of
  keeping the stale relocated draft (whose next save would overwrite the peer
  edit on every client); a same-cycle tombstone of it keeps its entry in
  `deletedIds`/`peerDeletedIds`, so the shell runs its deleted-during-sync
  close/keep-draft flow instead of leaving the editor bound to a nonexistent
  note. Consequently a relocation records its byproduct against the SOURCE id
  only — the "delete at the old name" plus the rename pair — never a synthetic
  update against the target. → futo-notes-sync `sync/outcome.rs`
  `remove_rename_ghost_ids` + `sync/collision_resolution.rs`
  `move_collision_loser` (guarded by
  `same_cycle_update_of_a_collision_relocated_note_survives_ghost_stripping`
  and
  `same_cycle_tombstone_of_a_collision_relocated_note_survives_ghost_stripping`
  in `sync/behavior_tests.rs`); desktop guarded by "reloads a followed rename
  target that also received a real update in the same cycle" and "closes the
  open note when a followed rename target was tombstoned in the same cycle" in
  src/features/sync/syncManager.test.ts
- A push checkpoint is written every 50 objects. → migration plan Phase 5
- A legacy `.app-state.json` is migrated on first run. → migration plan Phase 5
- **Concurrent-move dedup keys on OBJECT IDENTITY, never on (content-hash,
  basename).** When the SAME server object surfaces under two on-disk filenames
  in one cycle, it collapses to the highest-`change_seq` name and the redundant
  local copy is removed (local file + map entry only — no server DELETE, since
  the object survives under the winner and a DELETE would tombstone it). Two
  LEGITIMATELY DISTINCT notes that merely share a basename and content (e.g. two
  empty `Untitled.md` in different folders) are different objects and BOTH
  survive — the old (content-hash, basename) key deleted one of them on
  server+disk when a same-content delete happened in the same cycle (F9). →
  futo-notes-sync sync module; cross-platform
  scenario "distinct same basename survives move dedup"
- **Sync is push-first on every client and every trigger.** The native (iOS /
  Android) FFI `sync_now`, the SSE live loop, and the debounced auto-push all
  run the same full push-first cycle as desktop. A
  locally-edited-but-unpushed note is therefore PUT before any
  pull writes to disk, so a peer edit arriving via SSE can never silently
  overwrite it (the push 409 path runs the 3-way merge / conflict-copy, and the
  subsequent pull starts from the pre-push cursor so the just-pushed edit is
  never re-downloaded). The pre-fix native path ran pull-then-push, so a pulled
  peer edit clobbered the unpushed local edit on disk before push could detect
  the conflict — silent data loss, `conflicts == 0` (F1). → futo-notes-ffi
  `SyncClient::sync_now` + `SyncSession::start_live`; server/cross-platform
  integration suites
- **A push may infer local deletions only from a complete vault scan.** Failure
  to read the vault root, any nested directory entry, or any file metadata
  aborts the cycle before the HTTP client is constructed and before any remote
  create, update, or tombstone. A partial scan is never treated as an
  authoritative list of missing files, because that could turn a transient
  local I/O failure into fleet-wide deletion of healthy remote objects.
  Likewise, a post-scan content-read failure while pairing a possible rename
  aborts before any HTTP mutation; the unreadable replacement is never skipped
  while its old mapped name continues into remote deletion. The
  scanner reads symlink metadata and never follows file or directory symlinks,
  so a vault link cannot upload content outside the selected root or recurse
  through a directory cycle. On Unix platforms, every later note/blob read,
  atomic write, remove, timestamp update, tombstone claim, and conflict
  relocation resolves each parent from an open vault-root directory descriptor
  with `NOFOLLOW`; a scan-to-use symlink swap therefore cannot escape the vault.
  Successful namespace writes/removes/renames fsync their affected parent
  directories and surface a directory-sync failure instead of reporting durable
  success. Because that error arrives after the namespace mutation, callers
  treat it as an uncertain commit and retry idempotently: the retry re-fsyncs
  even when the desired bytes already match, the removed leaf is already
  absent, or the rename has already reached its destination. Every newly
  created parent entry is also fsynced in its containing directory before use,
  including when retry finds an uncertain prior `mkdir` already present; only
  then may object-map/cursor checkpoints advance.
  Other platforms reject symlinks observed while resolving the path, but do not
  yet provide the same descriptor-relative race guarantee. The same fallible
  scanner is used by conflict/tombstone copy naming; no sync call site receives
  a best-effort file list. → futo-notes-sync `sync/vault.rs`,
  `sync/vault_fs.rs`, and `sync/push/`; regression tests `scan_reports_*`,
  `scan_never_follows_*`, `content_*_never_follow_*`,
  `collision_placement_never_renames_*`, and
  `incomplete_root_scan_stops_before_remote_deletion`
- **The persisted pull cursor never advances past changes we have actually
  pulled — even across a crash mid-push.** State carries TWO watermarks:
  `max_version` (the highest `change_seq` seen; push folds its uploads in and
  persists it mid-push via the interim checkpoint / tail flush / final persist)
  and `pull_cursor` (the `since` for the next pull). `run_sync` derives `since`
  from `pull_cursor`, and ONLY a completed `pull::pull_with_checkpoint`
  (incremental or bootstrap) advances it; push leaves it untouched. So a crash
  between a push state-persist and pull completion leaves `pull_cursor` at the
  last fully-reconciled position, and the restart still re-lists any peer object
  whose `change_seq` sat below our pushed seqs. Persisting only `max_version`
  (the pre-fix behavior) elevated the pull cursor past un-pulled peer changes,
  hiding them permanently until the peer re-touched the note or a disconnect
  forced a bootstrap pull from cursor 0 (F32). State-file compatibility +
  retroactive heal: `pull_cursor` is an additive serde-default field; a pre-field
  `.e2ee-state.json` (or a legacy `.app-state.json` import — the pre-port TS
  client folded its own pushes into `e2eeMaxVersion` the same way) may itself
  carry a crash-elevated cursor, so an absent `pull_cursor` is DISTRUSTED and
  seeded to 0. The first post-upgrade sync therefore re-lists from scratch —
  idempotent (`first_pass` hash/identity-dedupes, no re-downloads or conflict
  copies for already-synced notes) — and RETROACTIVELY heals any install already
  carrying hidden F32 damage. → futo-notes-sync `checkpoint.rs` + `sync/`
- **A final checkpoint write failure does not discard successful in-memory sync
  progress.** Push and pull return the updated `ConnectedState`, record one
  `FailureKind::Checkpoint` in the combined `SyncSummary`, and let
  `SyncSession` install that state. A retry in the same running session therefore
  retains uploaded object IDs and downloaded mappings/cursors instead of
  POSTing duplicate server objects. Pull ancestry is cleared only after its
  checkpoint is durably saved. This preserves the push-first sequence and both
  watermarks; it changes only how the local persistence failure is reported and
  installed. Guarded by
  `uploaded_state_survives_final_checkpoint_failure_in_the_running_session` and
  `downloaded_state_survives_final_checkpoint_failure_in_the_running_session`.
  A pull failure after a successful push preserves the same pushed state even
  when its interim checkpoint also failed; guarded by
  `uploaded_state_survives_when_checkpoint_and_following_pull_fail`.
  A fatal push-side delete-conflict recovery after earlier successful uploads
  likewise returns the partially advanced push state to the session; guarded by
  `uploaded_state_survives_a_later_fatal_delete_conflict`.
  If the process exits before a later checkpoint save succeeds, disk may still
  contain the older map/cursors. Creates are now safe across that window: their
  Mutation ID was checkpointed before dispatch, so restart replays the same
  retained server outcome and never mints another upgraded-server object.
  Updates and deletes
  retain their existing version-guarded retry behavior. Against a legacy server
  that ignores `Mutation-Id`, sync remains compatible but an ambiguous
  classic-create response retains the legacy duplicate risk. The visible
  checkpoint failure remains the signal that durable local state is behind. →
  futo-notes-sync `checkpoint.rs` + `sync/push/` + `sync/pull/` + `session/`
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
  insensitive FS no longer lose a note.** On apply (both incremental and
  bootstrap calls to `pull::pull_with_checkpoint`) a path collision is detected
  over the UNION of this pull's downloads, the persisted object_map, and on-disk
  files sharing the collision key (`nfc(name).to_lowercase()`). The object with the
  lexicographically smallest `object_id` keeps the canonical name; every other
  colliding object is materialized as `name (conflict <oid8>).md`, where
  `<oid8>` is the first 8 chars of the loser's globally-unique object_id. The
  winner key (`object_id`) and the loser name are pure functions of immutable,
  globally-unique inputs that every union member carries — so resolution is
  idempotent (editing the winner can't flip it), convergent (every client mints
  the identical loser name and the fleet lands on `{canonical, name (conflict
  <oid8>)}`), and safe even when the rival is already on disk / in the map and
  is NOT in the current incremental batch (F4 same-name; F5 NFC-vs-NFD). →
  futo-notes-sync sync module, futo-notes-core
  `files::collision_key` and
  `conflict_names::collision_conflict_filename`; regression tests
  `f4_same_filename_two_clients_no_note_lost`,
  `f5_nfc_nfd_collision_no_note_lost`, the `collision_*` unit tests
- **The bootstrap pull from cursor 0 never lets local silently overwrite an
  unseen remote.** When a local file diverges from a server object on a fresh
  empty map (no common ancestor ⇒ no safe 3-way merge), the remote is adopted on
  the canonical name and the local edits are parked in a deterministic `name
  (conflict <remote-oid8>).md` copy that the next push uploads as its own new
  object — instead of recording a divergence entry that the next push pushed
  over the never-reconciled remote (F6). → futo-notes-sync `sync/mod.rs`
  (`pull::pull_with_checkpoint(state, root, 0, ...)`) +
  `sync/pull/` (`preserve_unmapped_target`)
- **Disconnect demotes sync state to ancestry; it never just deletes it.**
  Disconnect (all three clients) replaces `.e2ee-state.json` with
  `.e2ee-ancestry.json` — filename → {objectId, last-synced content hash} —
  and the same demotion runs when a persisted state is dropped because the
  collection identity changed. The live cursor/object map is still discarded,
  so a reconnect can never propagate while-disconnected deletions as
  fleet-wide tombstones (missing local files are re-downloaded, as before).
  → futo-notes-sync `checkpoint.rs`, ffi `SyncClient::disconnect`, desktop
  `e2ee_disconnect`
- **A reconnect after fleet drift does not mint conflict copies for notes the
  device never edited.** The bootstrap pull from cursor 0 consults the ancestry
  file: for the same objectId, local hash == last-synced hash ⇒ only the remote
  moved/renamed ⇒ fast-forward to the remote path and remove the stale local
  path (no park, no duplicate object); remote hash == last-synced hash ⇒ only
  local was edited while disconnected ⇒ keep local and push it as an update to
  the SAME object (no park, no duplicate object). Both sides changed, or no
  ancestry (fresh install, notes copied in without dotfiles) ⇒ the conservative
  F6 park above. This closes the July 2026 incident where a
  password re-login on a device that had been disconnected for days parked a
  stale `(conflict <oid8>)` copy of every note edited elsewhere in the
  meantime and synced the copies to the whole fleet. → futo-notes-sync store +
  sync modules; reconnect scenarios in the server integration suite
- **A reconnect honors peer deletes made while this device was disconnected —
  it does not resurrect them.** The bootstrap pull from cursor 0 inspects server
  TOMBSTONES (deleted objects), not just live ones. For each tombstone it
  matches the ancestry (object_id → last-synced filename + hash): if the local
  file is unchanged since the last sync it is deleted (the peer's delete wins);
  if it diverged (edited while disconnected) the local edit is preserved in a
  deterministic `name (conflict <oid8>).md` copy that push re-uploads as its own
  new object, and the tombstoned name is removed; a tombstone with no ancestry
  entry is left alone. Before the fix the `live`-only filter dropped every
  tombstone, so the local file survived and the next push re-POSTed it as a
  brand-new object — resurrecting the deleted note on every device permanently.
  The reconcile deletes are folded into the summary (deleted count + deletedIds)
  so the client rescan gate fires. (F1) → futo-notes-sync sync module;
  cross-platform
  scenario "peer deletes while disconnected"
- `write_atomic_text` overwrites a destination that differs only in **filename
  case** from an existing file instead of failing. On case-insensitive
  filesystems (default APFS on macOS/iOS, NTFS) `fs::rename` returns EEXIST for
  a case-variant destination; before the fix one colliding note aborted the
  *entire* sync apply mid-download. The recovery PARKS the colliding entry as
  a hidden `.sf-bak-…` file (restored if the retry fails, deleted on success)
  rather than deleting it first — a crash mid-recovery leaves the old bytes
  recoverable on disk instead of losing them. → futo-notes-core
  `files/{atomic_write,parked_backup}.rs`; regression tests
  `recover_restores_a_note_stranded_in_a_parked_backup` and
  `recover_returns_a_divergent_backup_as_terminal`

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
  than adopted. The bootstrap pull from cursor 0 likewise converges
  matching-content files to the server timestamp. (Observed 2026-06-05: a
  content-identical rewrite on the Mac left `Markdown demo` sorted minutes
  newer than on Android/iOS.) → futo-notes-sync sync module

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
  double-tombstone path is gone. → futo-notes-sync sync module; F4/F5
  cross-platform scenarios.

## Instance journal

- **Every sync cycle writes one `sync_run` record to the instance journal
  *(desktop)*.** The record names why the cycle ran (`manual`, `live_catch_up`,
  `local_change`, `remote_change`, `safety_poll`), how long each phase took
  (bootstrap / push / pull / total), what it moved (pushed, pulled, deleted,
  conflicts, local writes, failures, renames, oversize skips, tombstones), the
  version watermarks either side of it (`max_version`, `pull_cursor`, tracked
  objects, oversize-skipped), and the per-file reconcile decisions with the
  reason each branch was taken. A cycle that fails is recorded too, with its
  error and the phases that did run. → futo-notes-sync `journal.rs` +
  `sync/mod.rs` (guarded by "a journaled cycle records one run with its trigger
  counts and decisions" and "a failed cycle is still journaled with its error
  and watermarks" in `session/cycle.rs`)
- **A decision line is only written where the cycle acted.** Unchanged files,
  no-op re-pushes, and already-current objects are not journaled: a vault-sized
  wall of no-ops would bury the lines that explain an incident. →
  futo-notes-sync `sync/outcome.rs` `ReconcileDecision`
- **Journaling never changes what sync decides and never blocks it.** The
  writer is a bounded queue plus one background thread; under pressure it drops
  events and reports the count as a `journal_drops` record rather than applying
  backpressure. Push-first ordering is untouched. → futo-notes-core
  `journal/`
- **The journal lives in the app data dir, never inside a vault, and is never
  uploaded.** Desktop resolves `<app data>/<bundle id>/journal`, so the
  dev/release split follows the bundle identifier and `FUTO_NOTES_DATA_DIR`
  redirects both; journal files must not sync and must not appear in the note
  list. Retention is a size-capped ring (~20 MB, oldest segment dropped). →
  futo-notes-tauri `instance_journal.rs`
- Read it with `just journal` (`tail`, `type <event>`, `last-sync`, `where`), or
  with `jq` over the JSONL directly. → scripts/journal.mjs
  > **Gap:** Only the desktop shell opens a journal. iOS and Android run the
  > same sync crate, but `SyncSession::set_journal` is not exposed through
  > `futo-notes-ffi`, so a native shell's runs are not recorded and `just
  > journal --dir` has nothing to read from a phone.

## Polling

- Desktop auto-sync poll interval is intentionally short (the SSE live stream is
  the push replacement; the poll remains the desktop fallback) — don't lengthen
  it. → project decision
- Native shells do not run a foreground poll loop; the SSE live stream plus its
  ~45 s safety poll cover liveness (see "Live sync (SSE)"). → futo-notes-sync
  `session/`

- **External filesystem changes to the open note mirror disk, IDE-style
  *(desktop)*.** A watcher `change` whose disk content differs from the
  session's last-saved baseline is adopted immediately when the session is
  clean; a dirty draft is protected first and the adoption is deferred until
  the draft settles (blur, composition end, or one scheduled settle pass when
  the deferral arises while the editor is already blurred — a deferral is
  retained, never dropped, when a save races the disk read). Equality with the
  live editor is still adopted as a zero-diff apply so the saved baseline
  advances. Active-note `change` events bypass
  recent local/sync-write TTL suppression — including events buffered during a
  manual sync — so content comparison, not event timing, decides whether they
  are genuine external edits. An active IME composition defers before any
  flush or open-note disk read, refreshes the storage projection, and re-drives
  reconciliation when composition ends (or on blur); the deferred pass flushes
  safely and re-reads current disk content. Only
  content matching the saved baseline is a self-write echo and is dropped by
  comparison rather than event counting. The session is
  re-checked after each asynchronous disk read: a note switch drops the stale
  adopt. Every non-composing active-note `change` flushes the session before
  reading, so a timer-scheduled or in-flight dirty draft first runs through
  `flush_draft` and either writes or parks against the current disk base.
  Reconciliation never adopts over a save scheduled during the asynchronous
  read; that save settles through the same path, and only the guarded post-park
  reconcile re-reads and adopts while the save queue is still technically in flight. If validation or
  a write failure leaves the forced flush dirty, the watcher refreshes storage
  and defers adoption; the final adopt gate also refuses to replace any dirty
  session outside the guarded post-park path. That path carries the exact body
  and title parked by the save and adopts only while the live editor still
  matches both, including across its asynchronous disk read. The save itself is
  conditional against the session's saved-content base:
  matching disk is written, identical disk converges without a rewrite, and a
  stale draft against diverged disk is parked as a conflict copy instead of
  clobbering it. After a park, desktop projects the copy and explicitly
  reconciles the open note from disk (no toast), so the peer/external bytes are
  adopted while the draft survives in the list. The store and sync share one
  process-wide mutation guard across their check/write spans, closing the
  remaining read→compare→write interleaving window. A `change` that reads empty
  content closes the session as an external deletion only when the note no longer
  exists; an existing empty note adopts normally, and either path still emits the change's
  save notification exactly once. A watcher `unlink` always closes the open
  session and shows "Note was deleted externally"; if an already-started save
  completes afterward, its disk write still notifies sync but cannot restore
  the cleared session. → createExternalChangeCoordinator.ts (guarded by
  createExternalChangeCoordinator.test.ts and the cross-platform scenario
  "external watcher protects dirty draft then settles")
- A remote edit to the **currently-open note** is adopted into the open editor
  when the local draft is clean (`content == savedContent`); a dirty draft
  still wins and is never overwritten *(iOS/Android)*. Without this, the open editor kept
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
  never be clobbered by the initial adopt decision. When a draft is protected
  because it is dirty or was edited during the running cycle, sync completion
  leaves the editor untouched but re-bases its saved-content baseline to the
  pulled disk content. The draft is therefore honestly dirty again, and the
  next ordinary `flush_draft` persists it against that pulled base; if disk
  already equals the editor, the same rebase silently makes the session clean.
  Rust live cycles advance their edit epoch only when a completion event
  arrives (synchronously, after that completion snapshots the previous epoch),
  never from an in-cycle start or connect signal: such signals reach the
  webview asynchronously, so an edit racing their dispatch could be captured
  as pre-cycle and adopted over. The epoch is therefore never meaningfully
  newer than the next cycle's true start — edits between live cycles, and all
  edits made while offline, are over-protected (the draft wins and is pushed)
  rather than ever under-protected. Live and JS-driven epochs are tracked
  separately and snapshotted when each completion arrives. Completion handlers are serialized, and each completion flushes a
  pending or in-flight save before reading disk and re-evaluating session
  identity and draft state;
  a parked save can therefore finish its guarded disk adoption before the
  completion chooses whether to adopt or rebase. Once a focused-editor
  adopt is deferred, blur re-reads current disk content through
  `reconcileOpenNote` and applies it silently if the same note is still open
  and it differs from the saved baseline; content already matching the editor
  is still applied as a zero-diff baseline advance. → noteSession
  `isEditorChangeEcho`, syncManager `handleSyncComplete` (guarded by "flushes
  a draft created while deferred before adopting sync content on blur"
  in syncManager.test.ts)

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
  `<title> (conflict YYYY-MM-DD)` copy, the remote content is adopted into
  the editor, and a "Conflicting edits saved to a copy" toast fires. A draft
  that already reached disk is covered by the push-first 409 machinery above
  instead. On iOS the park rides the engine's one flush verb
  (`flush_draft` — the same persist-or-park path as the leave/background
  flush, see editor.md "Saving & rename"), so the copy is named by the
  engine's conflict-naming rule and an identical double-park mints one copy;
  if the engine's serialized re-check instead finds the note back at the
  draft's base, gone, or already holding the draft's exact bytes (an in-flight
  autosave landed it first — Converged), the draft wins at the original id and
  nothing is parked: the editor keeps the draft and never adopts the pre-flush
  disk snapshot, so the just-persisted draft is not clobbered by the next
  keystroke's autosave (a converged flush is grouped with wrote/recreated, not
  with the park arm — issue #37). On Android the local edit is captured after the conflict-copy id
  is minted and immediately before the copy is written; the copy lands on
  DISK first and the remote is adopted last (crash-durable: a process death
  mid-flow never loses the captured edit; a stale background flush can't
  clobber the adopted remote because the conditional write skips on changed
  base — PKT-12 final ordering). Verified on the emulator 2026-06-09
  (held-dirty draft + peer edit → copy contained the draft, editor showed
  the remote). → futo-notes-store `flush_draft` (iOS);
  NoteEditorScreen.kt / NoteEditorView.swift `adoptExternalChange`
- A peer **deleting the currently-open note** closes the open session (route →
  home, "Note was deleted during sync" toast) instead of adopting its content;
  an unsaved local draft is kept open with an "Open note was deleted during
  sync; keeping local draft" toast rather than closed *(desktop, iOS)*. On
  desktop the path branches on `summary.deletedIds` — `read_note` returns `""`
  for a missing file on Tauri, so reading a deleted id yields `""`, and the old
  adopt-`""` path blanked the editor while the session stayed bound to the
  deleted id, so the next keystroke re-created the file and undid the delete
  fleet-wide (F4). iOS branches on the note no longer existing on disk after a
  live pull (`store.exists` false in `adoptExternalChange`), acts only for the
  visible editor (a buried wikilink editor must not pop the stack top), and
  relies on the engine's flush verb (`flush_draft` — a clean editor never
  flushes) so a clean note is never resurrected even before the close runs.
  The dirty-keep path is edit-wins: the debounced save re-creates the note
  with the local edits, and a leave/background flush of the kept draft
  converges on the same home via the verb's Recreated arm.
  → syncManager `handleSyncComplete` (guarded by "peer delete of open
  note closes editor" in tests/cross-platform-sync.mjs + the F4 seam tests in
  src/features/sync/syncManager.test.ts); iOS NoteEditorView `handleOpenNoteDeleted`.
  > **Gap:** Android leaves the open editor bound to the deleted id (its
  > snapshotFlow adopt early-returns on the missing note); the peer-delete
  > close/keep + banner is not yet ported there. The verdict it needs now
  > exists as one engine verb (`classify_open_note`, reachable over UniFFI);
  > what remains is the Compose side that renders it.
- **One engine verb decides what happens to the open note.** `Leave`, `Adopt`,
  `DeferAdopt`, `FollowRename`, `KeepDraft` (peer-deleted / diverged /
  converged) and `Close` are the whole vocabulary (CONTEXT.md: open-note
  disposition). A shell gathers the facts — its editor state plus one disk read
  — asks once, and applies the answer with a single re-validation that it is
  still on the same note; it never decides (ADR-0001, the pattern flush
  dispositions proved). Two invariants live in the classifier rather than in
  each shell: unsaved work is never replaced (persist-or-park at the open-note
  seam — a peer-deleted note with a draft stays open for the flush verb's
  Recreated arm), and a verdict that leaves the buffer alone always rebases the
  baseline onto what is actually on disk, so the next flush is an honest
  three-way decision instead of a clobber (F2). **A focused editor is never
  interrupted on any surface**: the verdict is `DeferAdopt` and the content is
  applied on the next blur, whether or not that host's adopt could have
  preserved the caret. Host adopt capability is deliberately NOT an input — one
  answer for all three shells, so a caret never moves under a typist.
  → futo-notes-sync `open_note.rs` (guarded by
  `every_reachable_fact_combination_has_one_verdict`,
  `a_dirty_draft_is_never_replaced` and
  `keeping_a_draft_always_rebases_onto_what_is_actually_on_disk`), projected by
  `e2ee_classify_open_note` (desktop) and `classify_open_note` (UniFFI)
  > **Gap:** No shell renders the verb yet — desktop, iOS and Android each
  > still run their own copy of the decision (two of them on desktop, with
  > different toast wording). The verb and both projections landed first so the
  > adoptions can be reviewed one surface at a time; desktop's is staged in
  > scripts/command-reachability-allowlist.json with its reason. Until then the
  > native in-place focused adopt above still stands; adopting the verb changes
  > it to a deferred adopt on blur.
