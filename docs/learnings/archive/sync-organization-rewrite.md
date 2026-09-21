# Organizing Sync Around Its Behavioral Owners

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/archive/sync-organization-rewrite.md
```

## Ownership map

- `server/` owns authentication and the real HTTP protocol.
- `checkpoint.rs` owns the live object map, both cursors, legacy import, and
  disconnect ancestry.
- `session/` owns connection lifecycle, the shared cycle mutex, live-task
  lifecycle, debounce/backoff policy, and SSE framing.
- `sync/mod.rs` owns only the push-first cycle sequence.
- `sync/push/` and `sync/pull/` own their respective operations.
- `sync/conflict_resolution/`, `sync/collision_resolution.rs`, and
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
  tests co-located in `session/live/event_stream.rs` (this rewrite landed the
  file at `session/event_stream.rs`; `refactor(sync): clarify session lifecycle`
  later moved it under `session/live/`).
- Failure categories and summaries retain their cross-shell wire shape:
  `failure_kind_wire_strings_are_stable`,
  `failure_messages_are_honest_and_deterministic`, and the
  `sync-summary-failure-shape` drift-registry entry.


## Bugs found

None. This was an ownership and navigability rewrite over an already-correct
behavioral center.


## Follow-up queue

The seven fault-injection cases were subsequently closed; see the “Follow-up queue —
closed” section in `docs/learnings/sync-rewrite.md`. This rewrite itself did not
recreate the old mock-client or planner architecture to test them.
