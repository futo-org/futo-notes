### Blob transfer and batching

- **A failed blob download never advances the cursor past the object.** The
  `max_version` persisted by a pull (including the bootstrap pull from cursor 0) is capped below the lowest failed `change_seq`, so the next cycle re-lists
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
- **Whether a local file needs uploading is decided by its content hash, never
  by its modified time or size.** Push reads every candidate and compares
  SHA-256 against the recorded object state; a match settles as unchanged
  without an upload. It must not shortcut that read on matching mtime+size,
  because two ordinary cases change neither: the engine keeps a note's own
  modified time when only its backlinks were rewritten by someone else's
  rename (`list.md`), and a same-length edit on a filesystem that does not
  advance mtime (Samsung f2fs/FUSE) moves nothing observable either. Skipping
  those leaves the peer holding different bytes under one server hash until an
  unrelated edit dislodges it. → `push::local_changes::prepare_upload`, guarded
  by `a_same_length_rewrite_that_kept_its_mtime_still_uploads` and the
  `backlink rewrite propagation` cross-platform scenario
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
