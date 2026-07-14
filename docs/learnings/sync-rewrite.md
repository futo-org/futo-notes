# Rewriting Sync From Its Behavioral Contract

## Outcome

We replaced the production `futo-notes-sync` implementation while treating the
real-server, SSE, and full desktop-to-desktop suites as the product contract.

Production sync code went from 11,498 lines to 2,607 lines, a 77% reduction.
The 8,519-line orchestrator, separate HTTP client/session/state abstractions,
and desktop-only session wrapper were replaced by one application API:
`SyncSession`.

The resulting crate has four responsibilities:

- `http.rs`: authentication and the real server protocol
- `store.rs`: persisted object map, cursors, legacy import, and disconnect ancestry
- `sync.rs`: push-first reconciliation, conflicts, collisions, and tombstones
- `live.rs`: session ownership, cycle serialization, and SSE

Both UniFFI and Tauri call the same session API. They no longer assemble live
tasks, state locks, cycle gates, and callback graphs independently.

The rewrite later rebased over changes to the old orchestrator. The
modify/delete conflict was deliberately resolved by keeping `orchestrator.rs`
deleted; none of the old orchestrator was adopted into the replacement.

## The central lesson

The old implementation mixed product behavior with implementation policy. It
had many planners, adapter closures, intermediate structs, and tests coupled to
those private seams. Editing it incrementally preserved most of the accidental
architecture.

The useful boundary was:

1. Product behavior is defined by black-box tests that exercise a real server
   and real application adapters.
2. Safety invariants from `docs/spec/sync.md` remain explicit requirements.
3. Private implementation structure is replaceable.
4. Old unit tests are evidence to translate, not APIs to preserve blindly.
5. A regression is fixed at the smallest shared ownership boundary, never in a
   platform-specific shell.

This is not “delete code until the compiler is green.” The real-server and
two-client suites are the product gate. They cover encryption, optimistic
versions, tombstones, cursor movement, conflicts, reconnect ancestry, SSE
recovery, watcher behavior, and convergence.

## Replication playbook

### 1. Start from a clean worktree

Never perform a rewrite in the primary checkout.

```sh
git fetch origin main
git worktree add ../futo-notes-sync-rewrite -b rewrite/sync origin/main
cd ../futo-notes-sync-rewrite
```

Record the starting commit and confirm the worktree is clean. Keep unrelated
changes out of the rewrite.

### 2. Identify the behavioral boundary

Read these before designing the replacement:

- `AGENTS.md`
- `apps/tauri/AGENTS.md`
- `docs/spec/sync.md`
- `crates/futo-notes-sync/tests/server_integration.rs`
- `crates/futo-notes-sync/tests/sse_live.rs`
- `tests/cross-platform-sync.mjs`
- the legacy unit tests being removed

Write down the invariants before deleting anything:

- Every cycle is push-first.
- A failed download cannot advance the pull cursor past that object.
- State is tied to a collection identity.
- Disconnect demotes state to ancestry instead of erasing history.
- Tombstones never silently destroy a divergent local edit.
- Incoming paths are classified before touching disk.
- Live and manual cycles share one gate and one implementation.

Translate each legacy test into a plain-English promise. Then classify it as:

- externally observable acceptance behavior;
- a small invariant worth a fast test in the new design;
- behavior already owned by a lower-level canonical crate;
- obsolete implementation or protocol policy;
- a real gap that needs new coverage.

Do this translation before deciding what to port. Porting test code first tends
to recreate the architecture the rewrite is supposed to replace.

### 3. Establish the real-server baseline

Use an isolated port and database. Never use the `:3005` demo server.

From `~/Developer/futo-notes-server`:

```sh
docker compose up -d postgres
DATABASE_URL=postgres://futo_notes:futo_notes@localhost:5433/futo_notes \
  bun run migrate
docker compose exec -T postgres \
  psql -U futo_notes -d futo_notes \
  -c 'TRUNCATE orphaned_blobs, objects, collections, sessions, users CASCADE;'
AUTH_MODE=dev \
PORT=3155 \
BLOB_DIR=/tmp/futo-notes-sync-acceptance \
DATABASE_URL=postgres://futo_notes:futo_notes@localhost:5433/futo_notes \
BLOB_GC_ENABLED=false \
  bun src/index.ts
```

In the client worktree:

```sh
FUTO_TEST_SERVER=http://127.0.0.1:3155 \
  cargo test -p futo-notes-sync \
  --test server_integration --test sse_live \
  -- --ignored --test-threads=1

node tests/cross-platform-sync.mjs
```

### 4. Design one owner before implementing details

The replacement centers on `SyncSession`. It owns:

- optional connected state;
- the mutex serializing all cycles;
- the live task and cancellation handle;
- connect, resume, sync, disconnect, status, and local-change notification.

The shells provide only progress reporting and pre-write watcher suppression.
This prevents desktop and native clients from inventing subtly different cycle
order or lifecycle behavior.

### 5. Replace the center, then collapse the edges

Implement in this order:

1. The real HTTP contract used by the current server.
2. Minimal persisted state and legacy-state import.
3. Push, pull, and push-first reconciliation.
4. Session ownership and SSE.
5. UniFFI projection.
6. Tauri projection.

Delete obsolete production modules once their behavior is represented in the
new center. Do not keep forwarding layers “just in case.” Application code
must use `SyncSession`.

### 6. Let full-stack failures refine the model

Several important rules emerged only from the full two-client suite:

- Live shutdown must abort immediately. Cooperative cancellation allowed a
  stopped background cycle to race a manual scenario.
- Summary composition must include uploads performed during bootstrap and
  reconciliation, not only the nominal push phase.
- Rename events may be inferred only when a content hash is unique on both
  sides. Otherwise distinct identical notes can be merged incorrectly.
- The delete pass considers only mappings missing at the start of push. A
  conflict copy created mid-cycle must not be tombstoned immediately.
- When one client moves a note and a stale peer edits the old path, the merge
  retains the remote move while applying the edit.
- When both clients intentionally move the same object, the later
  optimistic-version update wins.

The translated unit tests exposed three additional gaps:

- Rename summaries could emit phantom create/delete IDs alongside the rename.
- Disconnect could leave dangerous live state behind if ancestry persistence
  failed.
- Tombstone handling had a crash window between inspecting and deleting local
  bytes.

The fixes belong to the shared engine: ghost events are removed when summaries
combine, live state is removed after best-effort ancestry persistence, and a
tombstone atomically claims local bytes before deleting, parking, or restoring
them.

### 7. Verify every consumer

```sh
cargo test -p futo-notes-sync
cargo test -p futo-notes-ffi
cargo check -p futo-notes-tauri
cargo clippy -p futo-notes-sync --all-targets --no-deps -- -D warnings

FUTO_TEST_SERVER=http://127.0.0.1:3155 \
  cargo test -p futo-notes-sync \
  --test server_integration --test sse_live \
  -- --ignored --test-threads=1

node tests/cross-platform-sync.mjs
git diff --check
```

For this rewrite, after rebasing onto current `main`:

- 43/43 fast sync-crate tests passed
- 25/25 real-server integration tests passed
- 2/2 live SSE tests passed
- 30/30 desktop-to-desktop scenarios passed
- strict sync-crate Clippy passed
- sync, UniFFI, and Tauri consumers compiled

## Complete legacy-test ledger

### Why the ledger exists

The sync rewrite removed 171 tests together with the old implementation. That
was defensible only if those tests were first treated as evidence about product
behavior, not dismissed as implementation detail. This ledger translates every
removed test into a plain-English promise and records what happened to it.

The goal is not to preserve the old class and function boundaries. The goal is
to preserve observable behavior and data-safety invariants while allowing the
implementation to be genuinely different.

### Dispositions

- **Fast** — reimplemented as a small test against the new design.
- **Acceptance** — covered at a more useful boundary by the real-server, SSE,
  or desktop-to-desktop suites.
- **Core** — already owned and tested by `futo-notes-core`; duplicating it in
  the sync crate would create two authorities.
- **Obsolete** — asserted a private mechanism or server feature that the new
  design deliberately does not use.
- **Follow-up** — still meaningful and not yet exercised at the best boundary.

### Former `client.rs` tests (27)

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `parse_iso_ms_matches_js_date_get_time` | Server timestamps become the same millisecond value on Rust and JavaScript clients. | **Fast** |
| `auth_mode_from_str` | The advertised `dev` and `password` authentication modes select the right login flow. | **Acceptance** |
| `base_url_normalizes_trailing_slash` | A server URL works with or without whitespace and a trailing slash, and only HTTP(S) URLs are accepted. | **Fast** |
| `probe_returns_dev_when_server_advertises_dev` | Connecting honors the authentication mode advertised by the server. | **Acceptance** |
| `probe_falls_back_to_password_on_unreachable_server` | A failed server probe used to be guessed as password mode instead of being reported. | **Obsolete** — guessing after a network failure hides the real error. |
| `login_dev_round_trips_token` | Development login returns a usable user ID and bearer token. | **Acceptance** |
| `login_password_maps_401_to_bad_password` | A rejected password produces an authentication error rather than a generic sync failure. | **Acceptance** |
| `list_collections_sends_bearer_and_parses_ids` | Authenticated collection listing returns collection IDs. | **Acceptance** |
| `create_collection_returns_id` | Creating a collection returns its ID. | **Acceptance** |
| `get_key_material_handles_null` | A collection with no key material is distinguishable from a request failure. | **Acceptance** |
| `put_key_material_sends_expected_body` | Newly generated vault key material can be stored and read back. | **Acceptance** |
| `list_objects_passes_since_version_and_accepts_numeric_strings` | Incremental listing sends its cursor and accepts server integers encoded as numbers or decimal strings. | **Fast** for decoding; **Acceptance** for cursor behavior. |
| `get_blob_returns_raw_bytes` | Encrypted blobs are transferred without text conversion or byte changes. | **Acceptance** |
| `get_blob_propagates_404` | A missing blob is a visible download failure, not empty content. | **Acceptance** |
| `parse_batch_frames_roundtrips_all_statuses` | The retired binary batch response parser decoded success and per-key errors. | **Obsolete** — the current server contract has no batch endpoint. |
| `parse_batch_frames_rejects_structural_defects` | The retired batch parser rejected truncated or malformed frames. | **Obsolete** |
| `get_blobs_batch_returns_entries_in_request_order` | The retired batch endpoint associated each response with the requested key. | **Obsolete** |
| `get_blobs_batch_rejects_entry_count_mismatch` | The retired batch endpoint rejected missing response entries. | **Obsolete** |
| `get_blobs_batch_propagates_404_for_fallback_detection` | A missing batch endpoint activated a legacy per-blob fallback. | **Obsolete** — per-blob transfer is now the only path. |
| `transfer_timeout_scales_with_expected_bytes` | The retired client chose a larger timeout for a larger expected transfer. | **Obsolete** — this was transport policy, not product behavior. |
| `post_blob_object_sends_octet_stream` | Creating an object uploads encrypted bytes with the server's raw-blob content type. | **Acceptance** |
| `put_blob_object_handles_409_conflict` | An optimistic-version conflict is returned as structured conflict data. | **Acceptance** |
| `classifies_413_as_payload_too_large` | HTTP 413 is recognizable as an oversized note rather than an ordinary server error. | **Acceptance** |
| `post_blob_object_maps_413_to_payload_too_large` | An oversized new note is surfaced, skipped, and can recover after shrinking. | **Acceptance** |
| `put_blob_object_maps_413_to_payload_too_large` | An oversized update is surfaced without destroying the previous server version. | **Acceptance** |
| `delete_object_parses_response_without_blob_key` | A successful DELETE response may omit fields that only exist for live objects. | **Fast** |
| `delete_object_handles_409_conflict` | A delete racing another update enters conflict resolution instead of being treated as success. | **Acceptance** |

### Former `live.rs` tests (8)

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `parses_named_events` | Multiple named SSE events in one stream are delivered separately. | **Fast** |
| `ignores_comment_heartbeat` | SSE heartbeat comments do not trigger sync work. | **Fast** |
| `handles_crlf_and_split_chunks` | SSE parsing survives CRLF and arbitrary network chunk boundaries. | **Fast** |
| `multiline_data_dispatches_once` | One event with multiple `data:` lines is dispatched once. | **Fast** |
| `run_cycle_stops_on_collection_gone` | Live sync stops when its collection has been deleted. | **Acceptance** |
| `run_cycle_continues_on_transient_error` | A temporary sync failure does not permanently kill live sync. | **Acceptance** |
| `run_cycle_continues_on_success_and_noop` | Successful and no-op cycles leave live sync running. | **Acceptance** |
| `is_collection_gone_matches_only_the_prefix` | Only the explicit collection-gone error class terminates the live loop. | **Acceptance** |

### Former `session.rs` tests (5)

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `snapshot_set_clear_round_trip` | Connection status appears after connect and disappears after disconnect. | **Acceptance** |
| `status_blocking_matches_async_snapshot` | Synchronous status reports the same state as the session itself. | **Fast** |
| `status_blocking_does_not_panic_on_runtime_worker` | Asking for status from an async runtime worker never blocks or panics. | **Fast** |
| `status_blocking_returns_none_while_inner_locked` | Status is best-effort and nonblocking when session state is busy. | **Fast** |
| `stop_live_and_note_changed_are_safe_when_not_running` | Stop and local-change notifications are harmless before live sync starts or after it stops. | **Fast** |

### Former `state.rs` tests (19)

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `persist_then_load_round_trip` | Object mappings and both push/pull watermarks survive restart. | **Fast** |
| `reset_when_collection_changes_keep_when_same` | Persisted live state is trusted only for the collection that created it. | **Fast** |
| `untagged_state_with_data_resets` | Old state with data but no collection identity is not trusted. | **Fast** |
| `empty_untagged_state_passes_through` | Empty legacy state is harmless. | **Fast** |
| `pre_field_state_distrusts_absent_pull_cursor_seeds_zero` | State from before the pull cursor field performs a full relist rather than skipping remote changes. | **Fast** |
| `missing_file_loads_empty` | First run and unreadable state start safely from empty state. | **Fast** |
| `json_field_names_match_ts_appstate` | Object-state JSON uses the cross-platform camel-case field names. | **Fast** |
| `entry_serde_round_trip_with_optional_absent` | Optional cached metadata may be absent and does not serialize as noisy nulls. | **Fast** |
| `migrates_legacy_app_state_when_no_e2ee_state` | Valid object mappings can be imported from the former app-state file. | **Fast** |
| `legacy_import_tagged_with_collection_survives_load_for_collection` | Imported state remains valid when its collection identity matches. | **Fast** |
| `legacy_import_resets_for_different_collection` | Imported state is discarded when it names another collection. | **Fast** |
| `legacy_import_without_collection_id_resets` | Imported data with unknown collection ownership is not trusted. | **Fast** |
| `prefers_e2ee_state_over_legacy` | Canonical sync state wins when canonical and legacy files both exist. | **Fast** |
| `demote_writes_ancestry_and_deletes_state` | Disconnect preserves verifiable ancestry but removes the dangerous live object map. | **Fast** |
| `demote_deletes_state_even_when_ancestry_write_fails` | Failure to save ancestry cannot leave live state behind and cause fleet-wide tombstones later. | **Fast** |
| `demote_without_state_keeps_existing_ancestry` | Repeated disconnect does not erase previously saved ancestry. | **Fast** |
| `load_ancestry_missing_or_garbage_is_empty` | Missing or corrupt ancestry is treated as unknown history, not invented history. | **Fast** |
| `load_for_collection_demotes_on_mismatch_keeps_on_match` | Loading state for the same collection preserves it; loading for another collection demotes it. | **Fast** |
| `delete_state_file_is_idempotent` | Deleting already-absent live state succeeds. | **Fast** through repeated demotion. |

### Former `orchestrator.rs` tests (112)

#### Download planning, cursors, and pull selection

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `plan_download_jobs_packs_smallest_first_under_byte_cap` | The retired batch planner packed smaller downloads together under a byte budget. | **Obsolete** |
| `plan_download_jobs_flushes_when_next_object_would_overflow` | The retired batch planner started a new request before exceeding its byte budget. | **Obsolete** |
| `plan_download_jobs_splits_at_byte_cap_and_demotes_oversize` | The retired batch planner isolated large blobs and used single requests for oversized jobs. | **Obsolete** |
| `plan_download_jobs_splits_at_key_cap` | The retired batch planner obeyed a maximum key count. | **Obsolete** |
| `plan_download_jobs_single_object_stays_on_legacy_path` | A single download bypassed batching. | **Obsolete** — every download now uses the direct path. |
| `cap_cursor_holds_below_lowest_failed_change_seq` | A failed remote change prevents the cursor from advancing past that change. | **Fast** |
| `cap_cursor_no_failures_passes_through` | With no failed changes, the cursor advances to the highest observed sequence. | **Fast** |
| `cap_cursor_change_seq_zero_pins_cursor` | A failure whose sequence is unknown forces a full retry from zero. | **Fast** |
| `failure_message_covers_download_and_decrypt_kinds` | Download and decryption failures produce distinct, honest user messages. | **Fast** |
| `first_pass_downloads_new_and_tombstones_known_deletes` | Pull downloads new/changed live objects and applies deletions only to known objects. | **Fast** plus **Acceptance**. |
| `first_pass_skips_already_synced_at_same_version_and_blob` | An object already represented by the same version and blob does not redownload. | **Fast** |
| `first_pass_redownloads_when_blob_rotates_at_same_version` | A changed blob key forces a download even if the object version is unchanged. | **Fast** |
| `first_pass_advances_max_version_even_when_nothing_to_apply` | Observing already-current objects still advances the appropriate server watermark. | **Acceptance** |

#### Push planning, renames, summaries, and failures

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `plan_push_fast_path_skips_matching_mtime_size` | An unchanged local file is not hashed and uploaded every cycle. | **Acceptance** via no-op and mtime scenarios. |
| `plan_push_detects_deletes` | A formerly mapped syncable file missing on disk becomes a server tombstone. | **Acceptance** |
| `plan_push_never_tombstones_non_syncable_map_entry` | Hidden, legacy, or otherwise unsyncable map entries are not turned into destructive deletes. | **Fast** plus **Acceptance**. |
| `plan_push_uploads_brand_new_files` | A new syncable local file is uploaded. | **Acceptance** |
| `plan_push_uploads_when_hash_missing_from_entry` | Incomplete old cache metadata cannot suppress a real upload. | **Acceptance** |
| `derive_renames_matches_hash_across_phases` | A unique same-content delete/create pair is reported as one rename. | **Fast** plus **Acceptance**. |
| `derive_renames_skips_when_no_match` | Unrelated creates and deletes are not mislabeled as renames. | **Fast** |
| `combine_summaries_drops_ghost_delete_for_renamed_id` | A rename does not also report phantom create/delete events for the same note. | **Fast** |
| `combine_summaries_merges_push_and_pull_failures` | Failures from both halves of a push-first cycle reach the caller. | **Fast** |
| `failure_message_none_for_clean_cycle` | A clean cycle has no failure banner. | **Fast** |
| `failure_message_singular_vs_plural` | Failure text uses correct singular and plural forms. | **Fast** |
| `failure_message_appends_most_frequent_status` | Server failures include the most representative HTTP status. | **Fast** |
| `failure_message_tie_keeps_first_seen_status` | Equal status frequencies have a deterministic tie-break. | **Fast** |
| `failure_message_checkpoint_is_local_not_server` | A local state-save failure is not described as a server failure. | **Fast** |
| `failure_message_mixed_server_and_checkpoint` | Mixed server and local persistence failures report both causes. | **Fast** |
| `failure_kind_wire_strings` | Failure categories retain their public string values. | **Fast** |
| `fold_reconcile_surfaces_adoptions_as_downloads` | First-sync adoption appears to callers as downloaded content. | **Acceptance** |
| `fold_reconcile_no_op_when_nothing_adopted` | Empty-map reconciliation does not invent work. | **Acceptance** |
| `fold_reconcile_dedupes_ids_already_present` | The same changed note appears once in a cycle summary. | **Fast** |
| `combine_summaries_carries_push_side_download_from_restore` | Conflict restoration writes are visible in the cycle result. | **Acceptance** |
| `combine_summaries_carries_local_writes_applied` | A clean merge records the local disk write without pretending it was a remote download. | **Acceptance** |
| `fold_reconcile_carries_local_writes_applied` | Reconciliation reports local writes consistently. | **Acceptance** |
| `combine_summaries_routes_dup_losers_to_deleted_lists` | When a duplicate move is removed, observers are told which local and peer IDs disappeared. | **Acceptance** |
| `filename_basename_strips_path_prefix` | Move matching compares the note basename independently of its folder. | **Core** |
| `dup_losers_empty_when_only_one_candidate` | A normal one-source/one-destination move is never mistaken for a duplicate race. | **Acceptance** |
| `dup_losers_picks_lower_change_seq_when_two_folders_compete` | Two destinations for the same object converge deterministically. | **Acceptance** |
| `dup_losers_keeps_distinct_objects_sharing_basename_and_content` | Distinct notes survive even when basename and content are identical. | **Acceptance** |
| `dup_losers_ignores_basename_mismatch` | Same-content notes with different basenames are not deduplicated as a move race. | **Acceptance** |
| `dup_losers_tiebreaks_lexicographically_on_same_change_seq` | An otherwise exact duplicate-move tie converges deterministically. | **Acceptance** |
| `dup_losers_deduplicates_filename_appearing_in_both_maps` | One duplicate destination is removed once even if seen in push and pull bookkeeping. | **Acceptance** |
| `pair_local_moves_detects_rename` | Moving a known file to a folder while keeping its basename updates the existing object. | **Acceptance** |
| `pair_local_moves_skips_ambiguous_basenames` | Ambiguous same-basename candidates are not guessed into moves. | **Fast** through unique-hash rename inference and **Acceptance**. |
| `pair_local_moves_skips_when_file_still_on_disk` | Copying a note does not rename the original object. | **Acceptance** |
| `pair_local_moves_skips_when_basenames_differ` | Unrelated delete/create changes are not paired solely by timing. | **Fast** |
| `plan_push_includes_local_moves_even_when_hash_unchanged` | A pure move is still pushed even when note content did not change. | **Acceptance** |
| `union_deleted_hashes_prefers_push_over_pull_on_collision` | Rename inference chooses the local deletion name deterministically when both phases saw the same hash. | **Fast** through deterministic rename inference. |
| `filename_to_id_strips_md_suffix_only` | UI note IDs preserve folders and remove only the final Markdown suffix. | **Fast** |

#### Files, paths, images, and collision handling

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `safe_relative_sync_path_rejects_traversal` | Remote names cannot escape the notes root through absolute paths or `..`. | **Core** plus **Fast** at sync triage. |
| `list_notes_skips_hidden_and_finds_md_and_images` | Local scanning ignores app/hidden files while including Markdown and supported images. | **Fast** |
| `image_blob_round_trips_through_apply_and_read` | Binary images survive encode, encryption payload handling, and disk write byte-for-byte. | **Core** plus **Acceptance**. |
| `apply_delta_writes_and_deletes_round_trip` | Applying a remote upsert writes its bytes and applying a tombstone removes only the intended file. | **Acceptance** |
| `apply_delta_fires_pre_write_for_each_filename` | Every sync disk mutation warns the watcher before writing. | **Acceptance** in the desktop harness. |
| `current_date_is_yyyy_mm_dd` | Conflict-copy dates use the public `YYYY-MM-DD` shape. | **Fast** |
| `collision_both_in_batch_parks_loser` | Two case-colliding remote notes both survive, with one parked under a deterministic conflict name. | **Fast** plus **Acceptance**. |
| `collision_rival_is_map_only_loser_download_parked` | An incoming winner cannot overwrite a mapped on-disk rival; the loser survives as a conflict copy. | **Acceptance** |
| `collision_map_only_loser_is_renamed_on_disk` | If the mapped file loses a deterministic collision, it is moved aside before the winner lands. | **Acceptance** |
| `collision_nfc_vs_nfd_detected` | Unicode composed/decomposed filename equivalents collide consistently across filesystems. | **Core** plus **Acceptance**. |
| `collision_is_idempotent_under_winner_edit` | Repeated winner updates do not generate an endless chain of conflict copies. | **Core** plus **Acceptance**. |
| `collision_loser_name_is_client_independent` | Every client chooses the same collision winner and loser filename. | **Core** |
| `collision_identical_content_adopts_silently_no_conflict_copy` | Identical colliding content converges without a pointless duplicate file. | **Fast** plus **Acceptance**. |
| `collision_identical_map_only_loser_is_dropped_not_parked` | An identical mapped loser is deduplicated rather than preserved as fake conflict content. | **Acceptance** |
| `collision_same_object_id_is_not_a_collision` | Multiple observations of the same server object do not collide with themselves. | **Fast** |
| `collision_distinct_names_no_action` | Non-colliding names are left unchanged. | **Core** |
| `collision_ignores_tombstoned_map_entry` | A deleted old mapping cannot block a new live filename. | **Acceptance** |

#### Former mocked pull/reconcile scenarios

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `run_pull_lands_notes_via_batch_endpoint` | Pull downloads and lands remote notes. | **Acceptance**; the batch-specific route is **Obsolete**. |
| `run_pull_ignores_legacy_image_blob` | Legacy image-object encodings are not materialized as bogus notes. | **Fast** plus **Acceptance**. |
| `run_pull_heals_creatable_but_unsyncable_name` | A remote name that is safe to heal is written under its canonical safe spelling. | **Fast** |
| `run_pull_heal_is_idempotent_across_cycles` | A healed name is stable on later cycles. | **Core** plus **Acceptance**. |
| `run_pull_rejects_structurally_unsafe_name` | Structurally unsafe remote paths are rejected without touching disk. | **Fast** |
| `run_pull_healed_names_collide_and_both_survive` | Healing two names into a collision still preserves both notes. | **Fast** plus **Acceptance**. |
| `reconcile_empty_map_heals_ignores_and_rejects` | First sync applies the same path rules as incremental pull. | **Acceptance** |
| `run_push_rejects_hostile_restored_filename` | A hostile filename recovered from old state cannot escape or corrupt the vault. | **Fast** |
| `run_push_heal_restore_parks_on_collision_with_unrelated_note` | Restoring a healed offline note cannot overwrite an unrelated local note at the healed path. | **Acceptance** |
| `run_pull_falls_back_to_per_blob_when_batch_unsupported` | Pull works when no batch endpoint exists. | **Acceptance**; fallback machinery is **Obsolete** because direct transfer is primary. |
| `run_pull_caps_cursor_on_failed_download_and_retries_next_pull` | A failed blob is retried next pull and later changes are not skipped. | **Follow-up** — the cursor rule is fast-tested, but a failing real/mocked blob boundary test should remain. |
| `reconcile_caps_cursor_when_failed_seq_below_succeeded` | First-sync reconciliation also caps the cursor below its earliest failed change. | **Follow-up** |
| `run_pull_cap_wins_when_push_already_advanced_cursor` | A push watermark cannot cause pull to skip a failed remote change. | **Follow-up** |
| `batch_4xx_skips_retry_ladder_and_degrades_to_singles` | A permanent batch request failure did not waste retries before using single downloads. | **Obsolete** |
| `batch_duplicate_blob_key_degrades_loser_to_single` | Duplicate keys in a batch did not misassociate content. | **Obsolete** |
| `reconcile_honors_peer_tombstone_deletes_unchanged_local` | Reconnect removes a locally unchanged note deleted by a peer. | **Acceptance** |
| `legacy_import_offline_edit_lands_as_clean_update` | An offline edit recovered through legacy ancestry updates the original object rather than creating a duplicate. | **Acceptance** |
| `reconcile_parks_local_edit_when_tombstoned_object_diverged` | A peer deletion never destroys a divergent offline local edit. | **Fast** plus **Acceptance**. |
| `reconcile_leaves_tombstoned_file_without_ancestry_alone` | Without verifiable object identity or ancestry, a tombstone cannot delete an unrelated local file. | **Fast** |
| `reconcile_unverifiable_tombstone_fails_caps_cursor_retains_ancestry` | If tombstone application cannot be verified, the cursor stays behind it and ancestry remains for retry. | **Follow-up** for the permission/error boundary; the decision rule is fast-tested. |

#### Tombstone crash safety

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `apply_tombstone_reconcile_deletes_only_on_hash_match` | A tombstone deletes unchanged content but parks divergent content. | **Fast** |
| `apply_tombstone_reconcile_counts_park_even_when_claim_cleanup_fails` | Once a divergent note is safely parked, the result reports the conflict even if cleanup metadata fails. | **Follow-up** |
| `apply_tombstone_reconcile_non_notfound_error_is_failure_not_convergence` | Permission or I/O errors are failures and never masquerade as a successful delete. | **Fast** |
| `claim_name_round_trips_original_filename` | The old reversible claim-name encoding recovered its source path. | **Obsolete** — the rewrite uses a bounded hash plus sidecar for every claim. |
| `claim_name_overflow_uses_bounded_hashed_form_plus_sidecar` | Tombstone claims remain within filesystem name limits even for long paths. | **Fast** |
| `recover_sweep_restores_orphaned_claim` | A crash after claiming a note restores it on the next cycle. | **Fast** |
| `recover_sweep_drops_claim_when_original_recreated` | A newly recreated original wins over stale crash-recovery content. | **Fast** |
| `restore_or_discard_leaves_claim_when_restore_fails_no_replacement` | Failed recovery preserves the claimed bytes for a later retry. | **Fast** |
| `apply_tombstone_reconcile_deletes_overflow_length_title` | Very long but valid titles can still be deleted safely. | **Fast** through bounded claim names. |
| `apply_tombstone_reconcile_deletes_overflow_deep_path` | Deep valid paths can still be deleted safely. | **Fast** through bounded claim names. |
| `recover_sweep_restores_overflow_claim_via_sidecar` | Long/deep-path crash claims restore through their sidecar path. | **Fast** |
| `recover_sweep_orphan_sidecar_deleted_orphan_hashed_claim_left` | Orphan sidecar metadata is cleaned without destroying an undecodable claimed file. | **Fast** |

#### Conflict, error, and restart scenarios

| Removed test | Plain-English promise | Disposition |
| --- | --- | --- |
| `resolve_update_conflict_post_413_surfaces_too_large` | Reposting conflict-preserved content that is too large remains visible and retryable. | **Acceptance** |
| `resolve_update_conflict_identical_content_adopts_remote_no_copy` | A 409 with identical content adopts the remote object without creating a conflict copy. | **Acceptance** |
| `resolve_update_conflict_peer_delete_preserves_edit_as_fresh_object` | If a peer deleted the object, a local edit survives as a fresh object. | **Acceptance** |
| `resolve_update_conflict_merge_onto_tombstone_reposts_fresh` | A clean merge discovered after remote deletion is reposted rather than lost. | **Acceptance** |
| `run_push_merged_clean_counts_local_write_not_download` | A clean push-side merge is reported as a local write, not a pull download. | **Acceptance** |
| `run_push_conflict_copy_counts_both_local_writes` | Writing both winner and conflict copy reports both local mutations. | **Acceptance** |
| `resolve_update_conflict_put_413_surfaces_too_large` | An oversized conflict update is surfaced without corrupting local or remote content. | **Acceptance** |
| `push_one_file_post_500_surfaces_error_with_status` | A server 500 during create reaches the summary with its status. | **Follow-up** — message formatting is fast-tested; transport injection is not. |
| `push_one_file_post_413_stays_too_large_not_error` | HTTP 413 follows the recoverable oversized-note path, not the generic 500 path. | **Acceptance** |
| `push_one_file_direct_put_onto_tombstone_reposts_fresh` | Updating an object concurrently deleted by a peer preserves the local note as a new object. | **Acceptance** |
| `dedup_loser_takedown_is_local_only_and_winner_survives` | Duplicate-move cleanup cannot tombstone the surviving server winner. | **Acceptance** |
| `crash_between_push_persist_and_pull_still_delivers_peer_change` | A restart after persisting push progress but before pull still downloads unseen peer changes. | **Follow-up** — both watermarks are fast-tested, but the restart boundary deserves an executable scenario. |
| `pre_field_state_first_sync_heals_hidden_peer_no_churn` | State written before the split cursor field does a safe full pull, heals hidden peer names once, and then converges. | **Acceptance** plus **Fast** state migration. |

## Current coverage shape

The replacement now has three deliberately different layers:

1. **43 fast sync-crate tests** for pure contracts and hard-to-observe safety
   decisions.
2. **27 real-server tests** (25 protocol/reconciliation and 2 SSE) for the
   encrypted HTTP boundary and live recovery.
3. **30 desktop-to-desktop scenarios** for watcher suppression, editor state,
   conflicts, moves, reconnects, and two-client convergence.

The fast layer intentionally does not recreate the former planners, adapters,
mock endpoints, or batch protocol. Its tests name behavior in the language of
state, files, remote objects, and public summaries.

## Follow-up queue

The audit leaves seven boundary cases worth adding without restoring the old
architecture:

1. Failed blob download caps the cursor and retries on the next pull.
2. The same cap applies during empty-map reconciliation.
3. A pull failure wins over a push watermark advanced in the same cycle.
4. Tombstone permission/I/O failures preserve ancestry and cap the cursor.
5. Tombstone conflict cleanup failure still reports the already-parked note.
6. HTTP 500 during create appears in the public failure summary.
7. Restart between push-state persistence and pull still receives a peer
   change.

These should be implemented with the smallest fault-injection seam that
exercises the current design. They should not bring back the old mock client,
batch planner, or orchestrator decomposition.

## Carry-forward audit of Tier-1 data-safety invariants

An independent audit checked whether each data-loss invariant fixed during the
architecture-hardening effort survived the rewrite with a test that can go red.

Result: all twelve invariants are implemented, and each has at least one
red-capable test. None is fully absent. Six were mutation-verified (break the
code, watch the named test fail, revert): cursor capping, tombstone
claim-and-park, stale-claim crash recovery, ancestry demotion, and
identical-content dedup.

Two invariants had **no test that runs in any automated pipeline**. Both are now
covered by offline crate-level unit tests in `sync.rs` (each proven red-capable
against the exact regression before finalizing):

- **413 oversize blobs.** The only prior test
  (`oversize_blob_is_surfaced_skipped_and_recovers`) gates on
  `FUTO_TEST_SMALL_BLOB_SERVER`, which CI never sets — CI boots only the 100 MiB
  `FUTO_TEST_SERVER`, so that test always early-returns. Added
  `push_skips_an_oversize_flagged_file_without_uploading_or_deleting_it` and
  `push_retries_an_oversize_flagged_file_after_its_mtime_changes`, covering the
  skip-while-unchanged and retry-on-mtime-change halves of the `oversize_skip`
  state machine (and that a skipped note is never tombstoned). The insert-on-413
  arm itself needs a real 413 response and remains covered only by the
  server-gated `oversize_blob_*` integration test — reproducing it offline would
  require a mock HTTP layer, which the rewrite deliberately removed.

- **F32 crash-window.** The design is safe — `push()` never advances
  `pull_cursor`; only a completed `pull()` does — but nothing asserted it. Added
  `push_preserves_the_pull_cursor`: a crash after push and before the following
  pull must re-deliver peer changes on restart. (This is the push-side half of
  boundary case 7 above; the full restart-injection case remains for a later
  fault-injection seam.) `cap_cursor` (failed download) and the 0-seed migration
  were already tested.

Three invariants remain red-capable only through the server or cross-platform
suites, with no cheap crate-level guard, and were **not** given offline tests:
push-first ordering inside `cycle()`, the merge-onto-tombstone local write in
`resolve_update_conflict`, and the `Mutation::Written if write.object.deleted`
branch of the rename-vs-edit case. Each is reachable only after a specific HTTP
response, so an offline test would require reintroducing the mock HTTP client the
rewrite removed. They run in CI on sync changes via `test:cross-platform-sync`;
restoring them offline is deferred rather than forced.
