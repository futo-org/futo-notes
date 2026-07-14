# Organizing Sync Around Its Behavioral Owners

## Outcome

Starting from `df7f844d1e9e3a04a1e5dd0ed9b9e6671ac2ed5c`, the sync crate was rebuilt
around the ownership rules in the codebase-layout blueprint without changing
its server protocol, persisted formats, public application API, or sync order.

Production code changed from 2,790 to 3,261 lines (+16.9%), counted before
`#[cfg(test)]` and excluding test-only files. The initial module split landed
at 2,926 lines; the follow-up helper extraction added 335 lines of private
functions and context types so push, pull, remote application, conflict
resolution, connection, and live streaming each read as short orchestration
sequences. No production behavior was deliberately added or removed.

The 43 fast tests were preserved one-for-one. The default crate command still
executes all 43, while discovering the same 25 real-server and 2 SSE tests as
ignored unless an isolated test server is supplied. The 30 desktop-to-desktop
scenarios remain the full application acceptance gate.

## Ownership map

- `server.rs` owns authentication and the real HTTP protocol.
- `checkpoint.rs` owns the live object map, both cursors, legacy import, and
  disconnect ancestry.
- `session/` owns connection lifecycle, the shared cycle mutex, live-task
  lifecycle, debounce/backoff policy, and SSE framing.
- `sync/mod.rs` owns only the push-first cycle sequence.
- `sync/push.rs` and `sync/pull.rs` own their respective operations.
- `sync/conflict_resolution.rs`, `sync/collision_resolution.rs`, and
  `sync/tombstones.rs` own the three data-preservation policies that should be
  independently discoverable during review.
- `sync/vault.rs`, `sync/encrypted_note.rs`, `sync/object_map.rs`, and
  `sync/outcome.rs` own the shared local-I/O, encrypted-object conversion,
  identity lookup, and result-contract concepts.

`lib.rs` remains the deliberate crate facade. `SyncSession` remains the
application API used by Tauri and UniFFI.

## Invariants and guarding tests

- Every cycle is push-first: `sync/mod.rs::cycle`; guarded by
  `f1_native_sync_is_push_first_no_silent_overwrite` and the cross-platform
  conflict scenarios.
- A failed download cannot advance the pull cursor past that object:
  `cursor_never_advances_past_the_first_failed_change`; the real transport
  fault-injection case remains in the established follow-up queue.
- State belongs to one collection identity:
  `collection_change_resets_and_demotes_state`,
  `untagged_state_with_data_is_not_trusted`, and
  `legacy_state_resets_for_a_different_or_unknown_collection`.
- Disconnect preserves ancestry but removes dangerous live state:
  `demote_writes_only_verifiable_ancestry_and_removes_live_state` and
  `demote_removes_live_state_even_if_ancestry_write_fails`.
- A tombstone cannot silently destroy a divergent local edit:
  `tombstone_deletes_unchanged_content_and_parks_a_divergent_edit`,
  `tombstone_without_identity_or_ancestry_cannot_delete_an_unrelated_file`,
  and the crash-claim recovery tests.
- Incoming paths are classified before disk mutation:
  `incoming_names_are_ignored_healed_or_rejected_before_writing`.
- Collision handling preserves distinct content and deduplicates identical
  content: `colliding_remote_notes_both_survive_but_identical_content_deduplicates`
  plus the F4/F5 real-server scenarios.
- Manual, live, and debounced cycles share one gate and implementation:
  `SyncSession` owns `cycle_gate`; `auto_pull_on_peer_push` and
  `reconnect_catches_missed_change` guard the real SSE boundary.
- SSE framing survives chunking, CRLF, comments, and multiline data: the four
  tests co-located in `session/event_stream.rs`.
- Failure categories and summaries retain their cross-shell wire shape:
  `failure_kind_wire_strings_are_stable`,
  `failure_messages_are_honest_and_deterministic`, and the
  `sync-summary-failure-shape` drift-registry entry.

## Test disposition ledger

No tests were deleted or declared obsolete in this rewrite. All 43 fast tests
were moved intact under their new owner or the cross-module
`sync/behavior_tests.rs` suite. The complete plain-English disposition ledger
for the 171 tests removed by the earlier behavioral rewrite remains in
`docs/learnings/sync-rewrite.md`; this change does not alter any disposition.

## Bugs found

None. This was an ownership and navigability rewrite over an already-correct
behavioral center.

## Verification

- Baseline: `cargo test -p futo-notes-sync` — 43/43 fast tests passed; 25
  real-server and 2 SSE tests discovered and ignored without a configured
  server.
- Rewritten crate: `cargo test -p futo-notes-sync` — 43/43 fast tests passed;
  the same 27 server-dependent tests were discovered.
- `cargo clippy -p futo-notes-sync --all-targets --no-deps -- -D warnings` —
  passed.
- `cargo test -p futo-notes-ffi` — compiled and passed (the crate currently
  defines zero tests).
- `cargo check -p futo-notes-tauri` — passed after creating the documented
  empty `dist/` prerequisite.
- Isolated real-server acceptance on `127.0.0.1:3155` — all 24 standard
  server cases and both SSE cases passed. The oversize case was correctly
  skipped there because it requires a separately constrained server.
- Isolated 4 KiB-blob server acceptance on `127.0.0.1:3066` —
  `oversize_blob_is_surfaced_skipped_and_recovers` passed.
- `just test-cross-platform`, with the server-repo override pointed at the
  temporary checkout and an isolated PostgreSQL database — all 30
  desktop-to-desktop scenarios passed with two real Tauri clients.
- `just check` — passed, including architecture gates, Rust conformance,
  lint/format checks, 391 curated TypeScript tests, type checking, and the
  production Vite build.

## Follow-up queue

The seven fault-injection cases in `docs/learnings/sync-rewrite.md` remain open.
This rewrite deliberately did not recreate the old mock-client or planner
architecture to force them into unit tests.
