# Sync Session Guided Contract Rewrite

## Rewrite status

- Workflow stage: Gate C complete; the user authorized merging the completed rewrite.
- Production implementation: final public green reached after the user-directed live-sync
  decomposition and the complete pre-merge verification chain.
- Gate A decision: approved by the user on 2026-07-20 with no amendments.
- Gate B decision: first packet rejected on 2026-07-20 because the live implementation remained
  hard to read and insufficiently decomposed into precisely named functions; the revised packet
  was approved by the user's instruction to merge the result into `bugs/various-fixes`.
- Gate C decision: complete on 2026-07-21; no semantic changes or unresolved in-scope findings.

## Workspace and base

- Worktree: `/Users/mason/.codex/worktrees/c7cf/futo-notes`
- Selected behavioral/code baseline: local branch `bugs/various-fixes`
- Exact base commit before edits: `50fcf1e45e4f7190a99b384f6eb5320989cdb8f0`
- Base commit subject: `fix(android): gate note action success`
- Worktree state before edits: clean, detached at the exact commit referenced by
  `refs/heads/bugs/various-fixes` because that branch is checked out in another worktree.
- Baseline policy: preserve this branch as the baseline; do not reset, rebase, or replace it
  with `main`.

## Declared scope

- Primary scope: `crates/futo-notes-sync/src/session/mod.rs`.
- Justified adjacent production scope: existing `session/connect.rs` and the SSE parser formerly
  at `session/event_stream.rs`, plus new `session/cycle.rs` and the focused
  `session/live/{mod.rs,runner.rs,connected_stream.rs,event_stream.rs}` capability. Exact reasons
  and dispositions are recorded below.
- External contracts: server APIs, persisted and wire formats, other crates, app shells, and product
  behavior. Structural work must preserve them unless a semantic change is separately approved.
- Narrowest owner: the `futo-notes-sync::session` capability. `SyncSession` is the sole mutable
  connection/cycle/live-task lifecycle owner; extracted modules may own stateless decisions or
  cohesive operations through explicit inputs.

General nearby cleanup is not authorization to rewrite the whole sync crate.

## Authorities read completely through EOF

- `/Users/mason/.codex/skills/guided-contract-rewrite/SKILL.md`
- `/Users/mason/.codex/skills/contract-rewrite/SKILL.md`
- `/Users/mason/.codex/skills/contract-rewrite/references/ledger.md`
- `/Users/mason/.codex/skills/contract-rewrite/references/futo-notes.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/workflow.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/architecture-pass.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/compliance-matrix.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/observed-runs.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/tauri-case-study.md`
- Repository `AGENTS.md`, `README.md`, and `justfile`
- `apps/tauri/AGENTS.md` for the inspected desktop consumer
- `docs/spec/AGENTS.md` and `docs/spec/README.md`
- `docs/spec/sync.md`, `docs/spec/app.md`, `docs/spec/desktop-rust.md`,
  `docs/spec/search.md`, and `docs/spec/settings.md`
- `docs/architecture/codebase-organization.md`
- `/Users/mason/Downloads/codebase-refactoring.md`

Read lease: all authorities above were read again completely after the latest context compaction;
the lease is valid for the current uncompacted modifying task and ownership approach. Reread the
required complete authorities after another compaction or foundational replanning.

## Gate A scope and accounting

The binding production scope is the complete `crates/futo-notes-sync/src/session/` capability:

- `session/mod.rs` is the nonconforming primary center and will be rewritten from its contract.
- `session/connect.rs` is included because connect/resume establishment is a named phase of the
  same session lifecycle. Its 155 production lines are already focused and will be reused as
  conforming code, not rewritten or moved.
- `session/event_stream.rs` is included because SSE framing is a private capability used solely by
  live session scheduling. Its 24 production/44 test lines are already focused and will be reused
  as conforming code.
- New `session/cycle.rs` and `session/live_sync.rs` owners are proposed below. They do not exist at
  the baseline.

Contract-evidence scope, inspected but not structurally rewritten:

- `crates/futo-notes-sync/tests/{common/mod.rs,server_integration.rs,sse_live.rs}`;
- `tests/cross-platform-sync.mjs`;
- the FFI and Tauri consumers named in the consumer matrix below.

Adjacent production collaborators inspected and excluded from the rewrite:

- `sync/mod.rs`: already a cohesive push-first workflow owner. Session calls it; moving its
  protocol sequencing would blur the approved boundary.
- `checkpoint.rs`: already owns persisted state, watermarks, and ancestry. Session only chooses
  lifecycle moments at which to load/save/demote it.
- `server.rs`: already owns HTTP request/response protocol. Session only asks it for a client and
  event stream.
- `lib.rs`: the crate facade and hidden server-acceptance compatibility surface. Its exports are
  frozen and require no structural change.
- `sync/{push,pull,...}`: canonical lower owners for reconciliation, encryption, collisions,
  tombstones, and summary composition. General sync-engine cleanup is explicitly out of scope.

This satisfies the user's adjacent-scope rule: only the two existing session siblings and the two
new session-owned modules are in the production ownership map. No file outside `session/` is
proposed for production modification.

The required helper is
`/Users/mason/.codex/skills/guided-contract-rewrite/scripts/account_scope.py`. Its inspected
heuristic counts source lines including blanks/comments, classifies files as tests by path/name,
and classifies Rust inline tests from the first `#[cfg(test)]`.

Command:

```text
python3 /Users/mason/.codex/skills/guided-contract-rewrite/scripts/account_scope.py \
  --repo . --base 50fcf1e45e4f7190a99b384f6eb5320989cdb8f0 --format markdown --largest 20 \
  crates/futo-notes-sync/src/session \
  crates/futo-notes-sync/tests/sse_live.rs \
  crates/futo-notes-sync/tests/server_integration.rs \
  crates/futo-notes-sync/tests/common/mod.rs tests/cross-platform-sync.mjs
```

| Baseline area                             | Production lines | Test lines | Files | Classification note                         |
| ----------------------------------------- | ---------------: | ---------: | ----: | ------------------------------------------- |
| Binding production capability, `session/` |              607 |        395 |     3 | Rust inline split manually confirmed.       |
| Unchanged assembled contract suites       |                0 |      3,618 |     4 | Test-only files.                            |
| Combined report                           |              607 |      4,013 |     7 | Accounting helper output; not a LOC target. |

| Baseline file                   | Production |  Test | Cohesive responsibility                                                                                                                     |
| ------------------------------- | ---------: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/mod.rs`                |        428 |   351 | Currently mixes public facade, connection/cycle ownership, live scheduling, retry/cancellation, and checkpoint-failure test infrastructure. |
| `session/connect.rs`            |        155 |     0 | Authenticate, select/create collection, obtain/unlock key material, and construct connected state.                                          |
| `session/event_stream.rs`       |         24 |    44 | Incrementally frame named SSE events across arbitrary byte chunks.                                                                          |
| `tests/common/mod.rs`           |          0 |    58 | Real-server suite setup and isolated vault helpers.                                                                                         |
| `tests/server_integration.rs`   |          0 | 1,310 | Real-server protocol, sync, and data-safety acceptance contract.                                                                            |
| `tests/sse_live.rs`             |          0 |   204 | Real-server live-session acceptance contract.                                                                                               |
| `tests/cross-platform-sync.mjs` |          0 | 2,046 | Two-real-desktop-client application acceptance contract.                                                                                    |

The earlier 3,594-production/3,102-test broad candidate run deliberately included all nearby sync
implementation. It was only an adjacency screen and is superseded by this binding scope.

## Baseline verification

| Command / setup                                                                                                                                                 | Exact result                                                                                                                                                                                     | Gate A interpretation                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `cargo test -p futo-notes-sync`                                                                                                                                 | 55 passed, 0 failed, 0 ignored in the default unit binary; 25 server + 2 SSE tests enumerated as ignored; doc tests 0.                                                                           | Focused baseline is green and non-vacuous.                                                                    |
| First `just qa-server`                                                                                                                                          | Failed before startup: `bun is required`; Bun existed at `/Users/mason/.bun/bin/bun` but was not on PATH.                                                                                        | Environment setup failure, no behavior executed.                                                              |
| Second `qa-server` with Bun on PATH                                                                                                                             | Failed before startup: default server checkout path absent.                                                                                                                                      | Environment setup failure; actual checkout found at `/Users/mason/futo-notes-server`.                         |
| First server-suite attempt against QA password-auth mode                                                                                                        | 1/25 reported passed, 24 failed with invalid-password/rate-limit errors.                                                                                                                         | Wrong server auth mode for this dev-auth suite; not a product baseline.                                       |
| Second password-auth attempt                                                                                                                                    | 5/25 passed before auth-mode assertion/rate limiting caused 20 failures.                                                                                                                         | Confirmed mode mismatch; server restarted correctly in dev mode.                                              |
| `FUTO_TEST_SERVER=http://127.0.0.1:3107 cargo test -p futo-notes-sync --test server_integration -- --ignored --test-threads=1` against isolated dev-auth server | Cargo reported 25/25 passed. Twenty-four tests executed substantively; `oversize_blob_is_surfaced_skipped_and_recovers` returned early because `FUTO_TEST_SMALL_BLOB_SERVER` was not configured. | Real-server baseline green; the small-blob case is separately classified Core below, not claimed as executed. |
| `FUTO_TEST_SERVER=http://127.0.0.1:3107 cargo test -p futo-notes-sync --test sse_live -- --ignored --test-threads=1`                                            | 2/2 passed.                                                                                                                                                                                      | Real SSE live-session contract green.                                                                         |
| First `just test-cross-platform`                                                                                                                                | Failed before scenarios: missing `ws`, with `node_modules` absent.                                                                                                                               | Fresh-worktree dependency setup failure.                                                                      |
| `just install`                                                                                                                                                  | Lockfile unchanged; 297 locked packages linked.                                                                                                                                                  | Setup only; no tracked source change.                                                                         |
| `PATH=/Users/mason/.bun/bin:$PATH FUTO_NOTES_E2EE_SERVER_REPO=/Users/mason/futo-notes-server just test-cross-platform`                                          | 30/30 passed, 0 failed, 0 skipped; total 296,335 ms.                                                                                                                                             | Full assembled desktop/server contract green.                                                                 |
| `cargo test -p futo-notes-ffi`                                                                                                                                  | 4/4 note-contract tests + 2/2 sync-contract tests passed; crate/bin/doc unit sets contained 0 tests.                                                                                             | Direct FFI consumer contract green and sync coverage nonzero.                                                 |

The manually started dev-auth server was stopped, and its isolated
`futo_notes_qa_s7` database/blobs were dropped after the baseline.

## Frozen behavioral and protocol contract

Product semantics are frozen by default. No exported action, signature, field, error, callback,
result, protocol identifier, persisted format, wire/encryption behavior, timing guarantee, or
lifecycle behavior is proposed for deletion or change.

### Named invariants

| ID  | Frozen invariant                                                                                                                                                                                                                        | Source                                    | Baseline guard                                                                               | Planned final guard                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S1  | `SyncSession` remains the one application session API used by FFI and Tauri; shells do not assemble their own sync lifecycle.                                                                                                           | `sync.md`, root ownership rules           | FFI sync contract; cross-platform 30/30                                                      | Same consumer tests + semantic-surface diff           |
| S2  | `SyncSession` is the sole owner of connected state, the cycle mutex, and live-task registration/start-stop. No ambient or second owner is introduced.                                                                                   | `sync.md`, both organization standards    | Source inventory; disconnected FFI lifecycle                                                 | Target-tree audit + state-owner review                |
| S3  | Every manual, initial-live, SSE, safety-poll, and local-change cycle executes the canonical full push-first workflow.                                                                                                                   | CRITICAL M3/M5 sync rules; `sync.md`      | `f1_native_sync_is_push_first_no_silent_overwrite`; `edit during sync keeps local draft`     | Same named scenarios + cycle call-path search         |
| S4  | Cycles are mutually exclusive. A caller can stop live work and wait until any cycle holding the vault finishes before storage migration.                                                                                                | `sync.md`, app storage safety             | `stop_live_and_wait_observes_the_cycle_gate`                                                 | Rewritten Fast test + Android consumer compile        |
| S5  | A successful upload/download remains installed in running-session memory even if the final local checkpoint save fails; one checkpoint failure is reported and retry does not duplicate remote work.                                    | `sync.md` final-checkpoint rule           | `uploaded_state_survives...`; `downloaded_state_survives...`                                 | Same promises co-located with `cycle.rs`              |
| S6  | Connect authenticates, converges on the account's authoritative collection/key, refuses to mint a key for a nonempty keyless collection, and persists initial state before reporting success.                                           | `sync.md`                                 | `connect_bootstrap_and_shared_vault`; `concurrent_connect...`; `missing_key_with_objects...` | Unchanged acceptance scenarios                        |
| S7  | Missing/deleted collections map to `CollectionGone`; a live cycle treats it as terminal so consumers can repoint instead of retrying forever.                                                                                           | `sync.md`                                 | two collection-gone server scenarios                                                         | Same scenarios + live error-path source audit         |
| S8  | Snapshot is an awaited exact clone; `status()` never blocks and reports unavailable while the state lock is contended.                                                                                                                  | shipped Rust/FFI behavior                 | `status_is_nonblocking...`; FFI lifecycle contract                                           | Same Fast/consumer tests                              |
| S9  | `start_live` requires a connected state, replaces any prior live task, and starts background work; `note_changed` and repeated `stop_live` calls are safe no-ops without a live task.                                                   | shipped API; `sync.md`                    | `stop_and_change_notifications...`; disconnected FFI lifecycle                               | Same Fast/consumer tests                              |
| S10 | A connected live stream performs an immediate catch-up cycle, treats `ready`/`change` only as debounced doorbells, and forwards the complete `SyncSummary`.                                                                             | `sync.md` live section                    | `auto_pull_on_peer_push`; FFI full-shape contract                                            | Same acceptance/consumer tests                        |
| S11 | Live liveness policy remains: 300 ms event debounce, 1 s local-push debounce, about 45 s safety poll, 90 s read-idle reconnect, and exponential reconnect backoff from 1 s capped at 30 s.                                              | `sync.md`; shipped scheduling behavior    | SSE reconnect scenario; cross-platform rapid reconnect/offline accumulation                  | Same acceptance scenarios + constants/scheduler audit |
| S12 | Stream read/EOF/idle and transient connect/client errors notify `on_error` then reconnect; HTTP 401 and `CollectionGone` terminate; cycle failures on a healthy stream call `on_cycle_error` without falsely reporting the stream down. | `sync.md`, desktop event contract         | Tauri listener shape; `reconnect_catches_missed_change`; collection-gone tests               | Tauri tests/compile + error-path audit                |
| S13 | Cancellation can interrupt connection, stream reading, debounce timers, safety waits, and backoff. `stop_live` remains prompt and idempotent; `stop_live_and_wait` adds cycle-gate quiescence.                                          | shipped lifecycle; storage migration spec | stop Fast tests; rapid reconnect; FFI lifecycle                                              | Same guards + source-level select/cancellation audit  |
| S14 | SSE framing accepts arbitrary network chunks and CRLF, emits one named event per frame, ignores comment heartbeats, and does not treat multiline data as multiple events.                                                               | server wire behavior                      | four `event_stream` Fast tests                                                               | Same unchanged tests                                  |
| S15 | Disconnect stops live work, clears live connection state, and demotes verified state to ancestry rather than deleting reconciliation knowledge.                                                                                         | `sync.md` disconnect invariant            | three reconnect server tests; peer-deletes-while-disconnected                                | Same acceptance scenarios                             |
| S16 | Encryption/key work stays client-side; key wrapping/unwrapping stays off async workers; server/wire/persisted formats remain byte/field compatible.                                                                                     | CRITICAL sync/data rules; `sync.md`       | real-server suites; FFI semantic-shape contract                                              | Semantic diff + full sync/consumer verification       |
| S17 | Session work remains background/nonblocking relative to editor typing; no synchronous per-keystroke network, crypto, filesystem, or lock wait is added.                                                                                 | CRITICAL M5; `sync.md`                    | architecture/source inspection; live cross-platform runs                                     | Dependency/state audit + full consumer verification   |

## Legacy-test promise ledger

The declared production scope contains nine legacy tests. All nine promises are retained; none is
obsolete, duplicated away, or deferred.

| Legacy file:test                                                                           | Plain-English promise                                                                                                                                                                              | Evidence/source                      | Classification | New guarding test/scenario                                  | Baseline status/count | Final status/count | Notes                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------- | ----------------------------------------------------------- | --------------------- | ------------------ | -------------------------------------------------------- |
| `session/mod.rs:status_is_nonblocking_and_reports_lock_contention_as_unavailable`          | Status returns the connected snapshot when immediately available and returns `None` instead of waiting when the state lock is held.                                                                | Shipped Rust/FFI status behavior     | Fast           | Same behavior statement beside the session facade           | Pass 1/1              | Pass 1/1           | Retained in facade vocabulary.                           |
| `session/mod.rs:uploaded_state_survives_final_checkpoint_failure_in_the_running_session`   | After a successful remote create whose final local checkpoint fails, the running session keeps the object mapping, reports exactly one checkpoint failure, and a retry does not POST a duplicate.  | `sync.md` final-checkpoint invariant | Fast           | Same behavior statement in `session/cycle.rs` tests         | Pass 1/1              | Pass 1/1           | Rewritten around the cycle capability, not the old seam. |
| `session/mod.rs:downloaded_state_survives_final_checkpoint_failure_in_the_running_session` | After a successful remote download whose final local checkpoint fails, the running session keeps the mapping/cursor, reports one checkpoint failure, and retry does not create a remote duplicate. | `sync.md` final-checkpoint invariant | Fast           | Same behavior statement in `session/cycle.rs` tests         | Pass 1/1              | Pass 1/1           | Rewritten around the cycle capability.                   |
| `session/mod.rs:stop_and_change_notifications_are_safe_without_a_live_task`                | Local-change notification and repeated live stops are safe when no live task exists.                                                                                                               | Shipped lifecycle behavior           | Fast           | Same behavior statement beside facade/live-task composition | Pass 1/1              | Pass 1/1           | Retained.                                                |
| `session/mod.rs:stop_live_and_wait_observes_the_cycle_gate`                                | Quiescing live sync waits until a cycle already holding the shared gate completes.                                                                                                                 | Android storage migration contract   | Fast           | Same behavior statement beside facade/live-task composition | Pass 1/1              | Pass 1/1           | Retained.                                                |
| `session/event_stream.rs:parses_multiple_named_events`                                     | Multiple complete named SSE frames in one chunk are emitted in order.                                                                                                                              | SSE wire behavior                    | Fast           | Unchanged test in conforming parser                         | Pass 1/1              | Pass 1/1           | Reused unchanged.                                        |
| `session/event_stream.rs:ignores_comment_heartbeats`                                       | SSE comment heartbeats emit no event while a subsequent named frame does.                                                                                                                          | SSE wire behavior                    | Fast           | Unchanged test in conforming parser                         | Pass 1/1              | Pass 1/1           | Reused unchanged.                                        |
| `session/event_stream.rs:handles_crlf_and_network_chunk_boundaries`                        | A named event split across chunks and delimited with CRLF is reassembled once.                                                                                                                     | SSE wire behavior                    | Fast           | Unchanged test in conforming parser                         | Pass 1/1              | Pass 1/1           | Reused unchanged.                                        |
| `session/event_stream.rs:multiline_data_dispatches_one_event`                              | Multiple data lines in one named frame still dispatch exactly one event.                                                                                                                           | SSE wire behavior                    | Fast           | Unchanged test in conforming parser                         | Pass 1/1              | Pass 1/1           | Reused unchanged.                                        |

Ledger totals at Gate A: **9 Fast, 0 Acceptance, 0 Core, 0 Obsolete, 0 Follow-up**
for the legacy in-module tests. The assembled suites below supply distinct boundary evidence rather
than duplicate replacements for these Fast promises.

### Assembled and lower-owner contract inventory

These 57 existing scenarios are not replacement unit tests. They freeze behavior outside the
private structure being replaced. `Acceptance` rows stay at their assembled boundary. `Core` rows
are canonically owned below session and remain unchanged; session proves delegation by continuing
to run the canonical cycle.

| Existing test/scenario                                                                  | Plain-English promise                                                                                    | Class      | Baseline         | Disposition                                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- | ---------------- | ------------------------------------------------------------------------------------- |
| `server_integration:connect_bootstrap_and_shared_vault`                                 | Two clients connect through dev auth and obtain the same user, collection, and usable vault key.         | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:concurrent_connect_converges_to_one_vault`                          | Racing first connects converge on one collection/key and can decrypt each other's note.                  | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:resume_after_vault_deleted_signals_collection_gone_then_reconnects` | Resume of a deleted collection returns the collection-gone heal signal and fresh connect repoints.       | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:missing_key_with_objects_does_not_mint`                             | A nonempty collection without key material fails safely; it never mints a destructive replacement key.   | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:run_sync_after_vault_deleted_signals_collection_gone`               | A running session surfaces collection-gone when its collection disappears.                               | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:single_note_round_trip_and_cursor_advance`                          | One uploaded note advances state and arrives byte-for-byte on a peer.                                    | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:update_propagates`                                                  | Updating a mapped note performs one upload and a peer receives the new bytes.                            | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:concurrent_edit_conflict_resolves`                                  | Concurrent edits preserve both sides through clean merge or conflict copy.                               | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:delete_propagates_as_tombstone`                                     | A local deletion becomes one tombstone and removes the peer file.                                        | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:move_to_folder_propagates`                                          | A same-object move reaches peers at the new relative path without the old path.                          | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:offline_accumulation_batch`                                         | Five accumulated local notes upload together and all arrive on a peer.                                   | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:large_note_round_trip`                                              | A 256 KiB note uploads and downloads without truncation.                                                 | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:raw_blob_lifecycle`                                                 | The external server blob API preserves opaque bytes across create/read/delete and returns 404 afterward. | Core       | Pass             | Server-protocol guard; unchanged.                                                     |
| `server_integration:touch_without_content_change_restores_server_mtime`                 | A content-identical local touch does not upload and is restamped to server time.                         | Core       | Pass             | Sync-engine guard; unchanged.                                                         |
| `server_integration:reconcile_identical_content_converges_mtime_to_server`              | Empty-map reconciliation of identical bytes adopts the authoritative server timestamp.                   | Core       | Pass             | Sync-engine guard; unchanged.                                                         |
| `server_integration:raw_error_contract`                                                 | Missing auth returns 401 and unknown collection returns 404.                                             | Core       | Pass             | Server-protocol guard; unchanged.                                                     |
| `server_integration:f1_native_sync_is_push_first_no_silent_overwrite`                   | A local unpushed edit survives a waiting peer edit because the assembled cycle pushes first.             | Acceptance | Pass             | Keep unchanged; primary S3 guard.                                                     |
| `server_integration:f4_same_filename_two_clients_no_note_lost`                          | Distinct same-key filenames both materialize; neither note is lost.                                      | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:f4_incremental_pull_rival_does_not_clobber_on_disk_winner`          | An incremental rival is ranked against persisted/on-disk state and cannot overwrite the winner.          | Core       | Pass             | Sync-engine guard; unchanged.                                                         |
| `server_integration:f5_nfc_nfd_collision_no_note_lost`                                  | NFC/NFD-colliding distinct objects both survive materialization.                                         | Core       | Pass             | Sync-engine guard; unchanged.                                                         |
| `server_integration:oversize_blob_is_surfaced_skipped_and_recovers`                     | HTTP 413 is surfaced, unchanged files are not retried, and a later smaller edit recovers.                | Core       | Environment skip | Keep unchanged; must not be claimed as baseline-executed without a small-blob server. |
| `server_integration:reconnect_after_remote_drift_fast_forwards_instead_of_parking`      | A clean disconnected file fast-forwards to remote drift without a conflict copy.                         | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:reconnect_after_local_edit_updates_same_object_instead_of_parking`  | An offline local edit updates the same object after reconnect and reaches peers without a copy.          | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:reconnect_after_remote_rename_deletes_stale_old_path_no_duplicate`  | Reconnect adopts a peer rename, deletes the stale path, and does not re-upload a duplicate.              | Acceptance | Pass             | Keep unchanged.                                                                       |
| `server_integration:measure_first_sync_large_vault`                                     | A fresh device reconciles at least the 500 seeded objects without failures while reporting timings.      | Acceptance | Pass             | Keep measurement harness unchanged; no new threshold.                                 |
| `sse_live:auto_pull_on_peer_push`                                                       | A connected live session receives an SSE doorbell and writes the peer note without manual sync.          | Acceptance | Pass             | Keep unchanged; primary S10 guard.                                                    |
| `sse_live:reconnect_catches_missed_change`                                              | Restarting live sync catches a change whose SSE event was missed while disconnected.                     | Acceptance | Pass             | Keep unchanged; primary S11/S12 guard.                                                |
| `cross-platform:image sync roundtrip`                                                   | Referenced image bytes sync and a second cycle does not re-upload them.                                  | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:editor roundtrip through real sync`                                     | Editor-created Markdown crosses the real app/server stack and appears on the peer.                       | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:edit during sync keeps local draft`                                     | An edit made while sync is running is not overwritten by the arriving peer state.                        | Acceptance | Pass             | Keep unchanged; primary S3 app guard.                                                 |
| `cross-platform:concurrent edit conflict`                                               | Conflicting application edits preserve both users' content.                                              | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:three way merge`                                                        | Nonoverlapping edits merge through the assembled clients.                                                | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:rename propagation`                                                     | A rename propagates without leaving the old note on the peer.                                            | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:active note reload`                                                     | A clean open note adopts a peer change after sync.                                                       | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:folder rename on A edit on B`                                           | Concurrent folder rename and peer edit preserve both path and content.                                   | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:file move on A edit on B`                                               | Concurrent file move and peer edit converge without losing either intent.                                | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:file moved to two folders by A and B`                                   | Competing moves preserve the note through deterministic conflict handling.                               | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:concurrent offline folder rename`                                       | Offline folder renames converge without dropping notes.                                                  | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:move note into folder delete folder`                                    | A move competing with folder deletion preserves the note.                                                | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:local rename and edit in same sync`                                     | One local cycle sends both a rename and content edit coherently.                                         | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:multiple local moves in one sync`                                       | Several local moves in one cycle retain the final identity/path state.                                   | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:both clients rename to same destination`                                | Competing destination renames preserve both notes via collision policy.                                  | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:folder X and file X coexist at same level`                              | A folder and note with the same stem coexist and sync.                                                   | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:move into folder with existing filename suffixes`                       | A local move resolves an occupied destination with the standard suffix policy.                           | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:empty folder does not sync`                                             | Empty folders are not represented as remote note objects.                                                | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:external watcher reloads clean note`                                    | A clean editor reloads an external on-disk change.                                                       | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:external watcher keeps dirty draft`                                     | A dirty editor is not clobbered by an external on-disk change.                                           | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:delete vs edit`                                                         | Concurrent delete/edit preserves the edit according to conflict policy.                                  | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:peer delete of open note closes editor`                                 | A clean open note closes instead of being silently recreated after peer deletion.                        | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:lost state recovery`                                                    | Removing local sync state triggers safe reconciliation rather than loss.                                 | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:rapid reconnect`                                                        | Rapid stop/reconnect remains usable and converges.                                                       | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:offline accumulation`                                                   | Multiple changes accumulated offline synchronize after reconnect.                                        | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:large sync`                                                             | The assembled stack completes its large-vault scenario.                                                  | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:tombstone does not block new note`                                      | A prior tombstone does not prevent a new live note at the name.                                          | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:peer deletes while disconnected`                                        | Reconnect honors a peer tombstone instead of resurrecting unchanged local content.                       | Acceptance | Pass             | Keep unchanged; primary S15 guard.                                                    |
| `cross-platform:edit vs peer delete preserves edit`                                     | A local edit competing with peer deletion survives as a live object.                                     | Acceptance | Pass             | Keep unchanged.                                                                       |
| `cross-platform:distinct same basename survives move dedup`                             | Distinct objects with identical basename/content are not collapsed by move deduplication.                | Acceptance | Pass             | Keep unchanged.                                                                       |

Combined evidence totals: **9 Fast + 50 Acceptance + 7 Core = 66 accounted tests/scenarios**;
**0 Obsolete, 0 Follow-up**. The two FFI consumer-contract tests are additional verification rows,
not part of the 66 declared sync-session promise ledger.

## Responsibility inventory

| Current path                    | Responsibilities                                                                                                                                                                                                                   | Owner                            | Public/private                                                  | State/effects                                                                  | Problem                                                                                                                                     | Disposition                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `session/mod.rs`                | Public session API; connected-state installation; cycle serialization; checkpoint-failure state installation; live task registration; SSE scheduling; cancellation/retry/error callback policy; five tests and a raw HTTP fixture. | `session`                        | Public facade + private mechanisms                              | Owns all three durable session fields and all live ephemeral state             | Too many independently nameable lifecycle/cycle/live responsibilities obscure the facade and make long functions the unit of comprehension. | Rewrite from frozen contract into facade + approved capability modules.                    |
| `session/connect.rs`            | HTTP auth-mode discovery/login; collection selection/creation; key-material load/create/unlock; checkpoint load/save; connected-state construction; authenticated client construction.                                             | session connection establishment | Private (`pub(crate)` only for hidden acceptance compatibility) | Remote calls, checkpoint I/O, `spawn_blocking` crypto; no durable module state | Focused, cohesive, explicit dependencies, no mixed scheduler/cycle ownership.                                                               | Reuse as already conforming.                                                               |
| `session/event_stream.rs`       | Buffer and frame named SSE events across chunks.                                                                                                                                                                                   | session SSE framing              | Private                                                         | Per-parser buffer only                                                         | Focused pure-ish protocol parser with co-located tests.                                                                                     | Reuse as already conforming.                                                               |
| `tests/common/mod.rs`           | Real-server environment, unique names, temporary vaults, cleanup.                                                                                                                                                                  | sync acceptance infrastructure   | Test-only                                                       | Process counter and temp filesystem                                            | Outside production ownership; exact server mode matters.                                                                                    | Keep unchanged.                                                                            |
| `tests/server_integration.rs`   | Real HTTP/auth/key/sync/reconciliation acceptance and measurement.                                                                                                                                                                 | assembled sync/server contract   | Test-only public boundary                                       | Real server + temp vaults                                                      | Large because it contains distinct acceptance classes, but out of structural scope and navigated by section comments/test names.            | Keep unchanged.                                                                            |
| `tests/sse_live.rs`             | Live session connects, auto-pulls, stops, restarts, and catches missed changes.                                                                                                                                                    | assembled live-session contract  | Test-only public boundary                                       | Real server, callbacks, timers, temp vaults                                    | Two coherent end-to-end live promises.                                                                                                      | Keep unchanged; update only stale narrative comments if the final symbol names require it. |
| `tests/cross-platform-sync.mjs` | Two real Tauri clients + real server across 30 application scenarios.                                                                                                                                                              | application acceptance           | Test-only public boundary                                       | Processes, server, vaults, UI state                                            | Out of structural scope; detects shell/integration regressions not visible to Rust unit tests.                                              | Keep unchanged.                                                                            |

### Current ownership problems

1. `session/mod.rs` has the correct state owner, but its 428 production lines also contain the
   roughly 228-line live state machine. Understanding the public facade therefore requires
   decoding SSE framing, deadline arbitration, exponential backoff, cancellation, and callback
   classification.
2. The manual and live cycle paths both perform the gate/clone/run/install transition, but that
   transition is only implicit in sibling code. The data-safety rule that successful in-memory
   progress survives a final checkpoint failure is consequently difficult to locate and audit.
3. Live-task registration, connected-stream scheduling, stream-versus-cycle error policy, and the
   task handle are interleaved in the module root even though they form one independently named
   long-running capability.
4. The 351 inline test lines are dominated by a raw HTTP fault-injection fixture for two cycle
   promises, so the facade's own lifecycle promises are hard to discover beside their owner.
5. `connect.rs` and `event_stream.rs` already have the desired focused shape. Rewriting or moving
   them would add churn without improving ownership.

The proposed split preserves the connected-stream sequence as one cohesive state machine. Its
goal is lower cognitive load and explicit ownership, not a line-count target or symmetrical files.

### Complete type and state-field inventory

| Current type/field                                                    | Contract or responsibility                                                                                                                                                   | Classification                                   | Target disposition                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `SyncSessionListener`                                                 | Cross-crate callback contract: rich `on_synced`, stream `on_connected`, stream `on_error`, distinct `on_cycle_error` with fallback to `on_error`, and terminal `on_stopped`. | Product semantic                                 | Preserve signature/default exactly in facade.                                                    |
| `ResumeCredentials.{server_url,token,user_id,collection_id,password}` | Complete resume input used by Tauri.                                                                                                                                         | Product semantic                                 | Preserve every field/name/type.                                                                  |
| `SyncSession`                                                         | Stateful application session object.                                                                                                                                         | Product semantic                                 | Preserve type/traits/default/public methods.                                                     |
| `SyncSession.state`                                                   | Optional connected snapshot, including key/map/watermarks.                                                                                                                   | Private mechanism implementing product lifecycle | Remains an owner-held `Arc<Mutex<Option<ConnectedState>>>`; no second stored copy.               |
| `SyncSession.cycle_gate`                                              | Serializes every manual/live cycle and provides storage-migration quiescence.                                                                                                | Private mechanism implementing S3/S4             | Remains owner-held and shared explicitly with cycle/live capability.                             |
| `SyncSession.live`                                                    | Registers at most one live task and makes start/replace/stop atomic from synchronous callers.                                                                                | Private mechanism implementing S9/S13            | Remains owner-held `std::sync::Mutex<Option<LiveTask>>`.                                         |
| `LiveTask.{cancel,note_changed,abort}`                                | Bounded cancellation and write-once local-change signals plus prompt abort handle.                                                                                           | Private mechanism                                | Move to `live_sync.rs`; returned/stored only by `SyncSession`.                                   |
| `CycleResult::{Continue,Stop}`                                        | Classifies live-cycle terminal collection-gone versus retryable cycle error.                                                                                                 | Private mechanism                                | Replace with a precise live-cycle outcome in `live_sync.rs`; do not export.                      |
| `StreamResult::{Reconnect,Stop}`                                      | Classifies stream completion for outer reconnect loop.                                                                                                                       | Private mechanism                                | Keep equivalent private enum in `live_sync.rs`.                                                  |
| `LiveContext`                                                         | Bundles explicit session state/gate/root/listener/pre-write references for stream cycles.                                                                                    | Private mechanism                                | Replace with narrower explicit capability inputs; reject a bag containing unrelated owner state. |
| `LiveInputs`                                                          | Bundles receivers, safety interval, and pending push deadline.                                                                                                               | Private mechanism                                | Keep live-loop-local or use a narrowly named scheduler input; no ambient state.                  |
| `EventStream.buffer`                                                  | Incomplete SSE frame text.                                                                                                                                                   | Private mechanism                                | Preserve in conforming parser.                                                                   |

Ephemeral loop locals are also frozen in responsibility: `safety` owns the delayed 45 s interval;
`backoff` owns the current 1–30 s reconnect delay; `push_at` and `pull_at` own independent debounce
deadlines; `EventStream` owns incomplete frame bytes. None becomes ambient/static mutable state.

### Complete production function inventory

| Current function/method                | Required behavior                                                                                                                                                  | Target owner/disposition                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `SyncSession::new`                     | Construct disconnected session with no live task.                                                                                                                  | `mod.rs`, preserve.                                                                                                |
| `SyncSession::connect`                 | Stop live; serialize against cycles; establish connection; install state only after successful connect/checkpoint; return full `ConnectInfo`.                      | `mod.rs` orchestration calling conforming `connect::connect`.                                                      |
| `SyncSession::resume`                  | Stop live; serialize; unlock the specified collection; install state only on success.                                                                              | `mod.rs` orchestration calling conforming `connect::resume`.                                                       |
| `SyncSession::sync`                    | Run one serialized canonical push-first cycle with real checkpoint persistence.                                                                                    | `mod.rs` facade delegating to `cycle::run`.                                                                        |
| `SyncSession::sync_with_checkpoint`    | Test seam for a cycle whose checkpoint persistence can fail; install returned in-memory state.                                                                     | Retire method-shaped seam; `cycle::run` accepts explicit save dependency privately and owns equivalent Fast tests. |
| `SyncSession::snapshot`                | Await and clone current state.                                                                                                                                     | `mod.rs`, preserve.                                                                                                |
| `SyncSession::status`                  | Try-lock and clone without blocking.                                                                                                                               | `mod.rs`, preserve.                                                                                                |
| `SyncSession::is_connected`            | Await current presence.                                                                                                                                            | `mod.rs`, preserve.                                                                                                |
| `SyncSession::disconnect`              | Stop live; serialize; clear memory; demote disk state to ancestry; surface I/O error.                                                                              | `mod.rs`, preserve exact ordering.                                                                                 |
| `SyncSession::start_live`              | Reject disconnected; replace old task; create bounded channels; spawn background runner; register task or report poisoned lock.                                    | `mod.rs` orchestration + `live_sync::start`.                                                                       |
| `SyncSession::note_changed`            | Nonblocking write-once signal; ignore absent/poisoned task.                                                                                                        | `mod.rs` delegates to private `LiveTask`.                                                                          |
| `SyncSession::stop_live`               | Atomically take task, try cancellation, abort promptly; safe repeatedly.                                                                                           | `mod.rs` delegates to private `LiveTask`.                                                                          |
| `SyncSession::stop_live_and_wait`      | Stop promptly then await cycle gate.                                                                                                                               | `mod.rs`, preserve; comment disposition below.                                                                     |
| `run_cycle`                            | Lock shared gate; require state; execute canonical cycle; install success before `on_synced`; report cycle error; stop only on collection-gone.                    | Split: reusable state transition in `cycle.rs`; live callback/outcome policy in `live_sync.rs`.                    |
| `cycle_stopped`                        | Project live cycle result to terminal boolean.                                                                                                                     | Eliminate boolean wrapper; use named private outcome in `live_sync.rs`.                                            |
| `run_connected_stream`                 | Immediate catch-up; independently debounce local pushes and SSE pulls; safety poll; parse chunks; reconnect on read/EOF/idle; honor cancellation.                  | Rewrite from contract in `live_sync.rs` as one cohesive connected-stream sequence.                                 |
| `wait_for_reconnect`                   | Wait cancelably; double delay capped at 30 s after a completed wait.                                                                                               | `live_sync.rs`, precise private helper.                                                                            |
| `live_loop`                            | Rebuild client from current state; connect SSE; classify terminal/retry errors; reset backoff on connect; emit callbacks; reconnect; emit stopped on natural exit. | Rewrite from contract in `live_sync.rs`.                                                                           |
| `deadline`                             | Sleep to an optional deadline or remain pending.                                                                                                                   | `live_sync.rs`, local private helper.                                                                              |
| `wait_or_cancel`                       | Race cancel against delay.                                                                                                                                         | `live_sync.rs`, local private helper.                                                                              |
| `connect::http_error`                  | Translate HTTP transport/status text to session HTTP error.                                                                                                        | Reuse.                                                                                                             |
| `connect::collection_error`            | Translate 404 to `CollectionGone`, other HTTP errors normally.                                                                                                     | Reuse.                                                                                                             |
| `connect::create_key_material`         | Wrap a fresh vault key on a blocking worker and map join/crypto errors.                                                                                            | Reuse.                                                                                                             |
| `connect::load_or_create_key_material` | Load existing key; refuse mint if objects exist; otherwise create and first-write-wins PUT.                                                                        | Reuse.                                                                                                             |
| `connect::unlock_vault_key`            | Unwrap key on a blocking worker and map errors.                                                                                                                    | Reuse.                                                                                                             |
| `connect::connected_state`             | Normalize URL and combine credentials/key with collection-validated checkpoint state.                                                                              | Reuse.                                                                                                             |
| `connect::connect`                     | Authenticate, choose/create collection, establish key, build/save state, return state/info.                                                                        | Reuse.                                                                                                             |
| `connect::resume`                      | Fetch required key for specified collection, unlock it, rebuild state without minting.                                                                             | Reuse.                                                                                                             |
| `connect::client`                      | Build authenticated HTTP client from a connected snapshot.                                                                                                         | Reuse.                                                                                                             |
| `EventStream::push`                    | Lossily decode bytes, normalize CRLF, retain incomplete frames, and return named events.                                                                           | Reuse with four tests.                                                                                             |

Test-only functions/types (`TempRoot`, `MutationServer`, `read_request`,
`serve_mutation_request`, `connected`, and fixture constructors/destructors) exist solely to drive
the two checkpoint-failure promises. They move together into `cycle.rs`'s inline test module;
their 1 MiB request cap, request-body draining, deterministic fake object versions, encrypted
remote-note fixture, post counter, shutdown signal, and cleanup semantics are retained. The five
test functions and four event-stream tests are individually disposed in the legacy ledger above.

### Protocol, ordering, retry, cancellation, and error inventory

| Concern                        | Frozen current sequence/decision                                                                                                                                                                                               | Evidence                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Connect                        | stop live → acquire cycle gate → auth-mode/login → collection list/create → key load/refuse/create → blocking unlock → load collection-matched checkpoint → save initial checkpoint → install state → return info              | server connection scenarios            |
| Resume                         | stop live → acquire cycle gate → authenticated key GET → 404=`CollectionGone`, missing key=`Crypto` → blocking unlock → load matched checkpoint → install state                                                                | resume/keyless scenarios               |
| Manual cycle                   | acquire gate → clone state or `NotConnected` → optional empty-map bootstrap pull → capture `pull_cursor` → push → pull from captured cursor → combine summary → install returned state even with summarized checkpoint failure | Fast checkpoint tests; F1              |
| Start live                     | verify connected → stop previous task → bounded cancel/change channels → spawn runner → store one task handle                                                                                                                  | FFI lifecycle; SSE tests               |
| Connected stream               | immediate full cycle → read chunks → `ready`/`change` set 300 ms pull deadline → local change sets 1 s push deadline → each deadline and 45 s safety tick runs full cycle under shared gate                                    | SSE + cross-platform live scenarios    |
| Stream reconnect               | client-construction error or non-401 connect/read/EOF/90 s idle error emits `on_error`; cancelable backoff doubles 1/2/4/.../30 s; successful stream resets to 1 s and emits `on_connected`                                    | SSE reconnect; Tauri callback mapping  |
| Terminal live errors           | missing state, cycle `CollectionGone`, HTTP 401, cancellation, or explicit stop end the runner; natural runner exit emits `on_stopped`                                                                                         | collection-gone and consumer contracts |
| Cycle errors on healthy stream | Emit `on_cycle_error`; continue unless `CollectionGone`; do not emit stream-disconnected state.                                                                                                                                | desktop `cycle-error` contract         |
| Stop                           | take registered task once → try cancel → abort; repeated/no-task calls do nothing. Wait variant then acquires cycle gate.                                                                                                      | two Fast tests                         |
| Disconnect                     | stop live → acquire gate → clear state → demote live checkpoint to verified ancestry; demote error remains visible while memory stays disconnected.                                                                            | reconnect acceptance                   |
| Error fidelity                 | `NotConnected`, `Auth`, `Http`, `Crypto`, `Io`, and `CollectionGone` categories/messages remain stable; no error is changed to success or swallowed at a boundary that promises it.                                            | FFI semantic-shape + server tests      |

## Contract and compatibility disposition

| Surface                                                                                                          | Surface kind                                         | Consumer(s)                                             | Shipped externally?       | Required behavior                                                     | Final owner                                    | Disposition                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `SyncSession` type and all 13 public methods                                                                     | Product semantic                                     | FFI, Tauri, hidden acceptance API                       | Yes, cross-crate          | Names/signatures/async shape/results and lifecycle semantics above    | `session/mod.rs`                               | Freeze exactly.                                                      |
| `SyncSessionListener` five callbacks including default `on_cycle_error` fallback                                 | Product semantic                                     | Tauri and FFI listener projections                      | Yes, cross-crate          | Callback data/classification/threading remain stable                  | `session/mod.rs`                               | Freeze exactly.                                                      |
| `ResumeCredentials` five fields                                                                                  | Product semantic                                     | Tauri `e2ee_resume`                                     | Yes, cross-crate          | Preserve every field/name/type                                        | `session/mod.rs`                               | Freeze exactly.                                                      |
| `ConnectInfo`, `SyncSummary`, `SyncFailure`, `SyncErrorKind`, `ConnectedState` returned/observed through session | Product semantic owned by lower modules              | FFI, Tauri, acceptance tests                            | Yes                       | Preserve complete fields/errors/non-reconstructible summary data      | Existing lower owners; facade re-export        | No reduction or remapping.                                           |
| Connect/resume/sync/disconnect ordering and side effects                                                         | Product semantic                                     | All shells and stored vault                             | Yes                       | Preserve table above                                                  | `SyncSession`                                  | Freeze.                                                              |
| Live timing, callback, terminal/retry, debounce, safety-poll, and cancellation behavior                          | Product semantic                                     | All shells and user-observed sync liveness              | Yes                       | Preserve S9–S13                                                       | `SyncSession` + private `live_sync` capability | Freeze.                                                              |
| `.e2ee-state.json`, `.e2ee-ancestry.json`, watermarks/object map                                                 | Product semantic persisted contract                  | Existing installations/all shells                       | Yes                       | No format or lifecycle change                                         | `checkpoint.rs` (outside scope)                | Preserve; session call moments unchanged.                            |
| HTTP paths/status meanings/SSE event names and encrypted blob/key material                                       | Product semantic wire contract                       | External server/existing clients                        | Yes                       | Byte/protocol compatible; 404 and 401 classifications unchanged       | `server.rs`/`connect.rs`/core                  | Preserve.                                                            |
| `lib.rs` hidden `connect/resume/run_push/run_pull/run_sync/state` surface                                        | Product semantic compatibility for acceptance suites | In-repo server tests; uncertain external Rust consumers | Conservative yes          | Preserve names/signatures/behavior                                    | Crate facade outside scope                     | No edit.                                                             |
| `SyncSession` field layout, channel types, private enums/context bags, helper names                              | Private mechanism                                    | No supported external consumer                          | No                        | May change if product behavior stays frozen                           | Private session modules                        | Replace with target ownership model.                                 |
| `sync_with_checkpoint` method-shaped injection seam                                                              | Private mechanism                                    | Two inline tests only                                   | No                        | Its checkpoint-failure promise must survive                           | `cycle.rs` private save dependency             | Remove old seam after tests move.                                    |
| Inline raw HTTP mutation fixture                                                                                 | Private test mechanism                               | Two Fast tests                                          | No                        | Preserve only the fault-injection capability                          | `cycle.rs` tests                               | Rewrite/co-locate; no production export.                             |
| UniFFI Swift/Kotlin generated bindings                                                                           | Generated artifact                                   | Native apps                                             | Derived/shipped in builds | Semantic API remains identical, so generated source should not change | FFI generation outside scope                   | Do not edit or regenerate unless an actual FFI-visible diff appears. |

## Target tree and provenance

| Target path               | Responsibility                                                                                                                                                                        | Dependencies                                                                              | State/lifecycle                                                                  | Expected size/risk                                                                               | Implementation provenance           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `session/mod.rs`          | Public session contract and top-down orchestration; sole owner of connected state, cycle gate, and registered live task.                                                              | `connect`, `cycle`, `live_sync`, `checkpoint`; public lower types                         | Owns all durable mutable session state/lifecycle                                 | About 180–230 production and 40–80 test lines; high correctness risk, lower cognitive load       | Rewrite from contract               |
| `session/connect.rs`      | Establish/resume authenticated encrypted connection and construct initial connected state.                                                                                            | core E2EE, `server`, `checkpoint`, sync contract types                                    | No stored state; remote/I/O/crypto effects explicit                              | 155 production; medium protocol risk                                                             | Reuse as already conforming         |
| `session/cycle.rs`        | Execute one serialized canonical cycle against explicit session-owned state, install returned progress, and own checkpoint-failure fault-injection tests.                             | `sync`, `checkpoint`, explicit state/gate/root/hooks/save                                 | No ambient state; borrows owner-held state/gate for one operation                | About 45–80 production and 280–340 test lines; high data-safety risk                             | New, written from captured contract |
| `session/live_sync.rs`    | Own the cohesive long-running live runner: task handle, SSE connection, immediate catch-up, debounce/safety scheduling, reconnect/backoff, cancellation, and callback classification. | `connect::client`, `cycle`, `event_stream`, Tokio/reqwest, explicit owner-held state/gate | Ephemeral runner-local timers/receivers; `LiveTask` stored only by `SyncSession` | About 230–290 production; high lifecycle risk; long file justified by one state-machine sequence | New, written from captured contract |
| `session/event_stream.rs` | Incrementally frame named SSE events.                                                                                                                                                 | Standard string buffer only                                                               | Per-parser buffer; no lifecycle ownership                                        | 24 production/44 test; low risk                                                                  | Reuse as already conforming         |

Expected sizes are review prompts, not quotas. The target intentionally does not create a module
for every helper, a generic state/manager/helpers file, or a transitional production/test
warehouse. Skeletons for `cycle.rs` and `live_sync.rs` must exist before the first implementation
compile after Gate A approval.

## State and lifecycle map

| Responsibility                           | Mutable/in-flight state                         | Lifecycle                                                                              | Stateless operation                                       | Intended owner/module                               |
| ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Connected credentials/key/map/watermarks | `Option<ConnectedState>` behind async mutex     | connect/resume install; cycles replace; disconnect clears                              | Clone/status queries                                      | `SyncSession` in `mod.rs`                           |
| Cycle exclusion/quiescence               | Async mutex                                     | Held for connect/resume/sync/live cycle/disconnect; waited after stop                  | None                                                      | `SyncSession`; borrowed by `cycle.rs`               |
| Registered live task                     | `Option<LiveTask>` behind sync mutex            | start replaces; stop takes exactly once                                                | Notification/abort methods                                | `SyncSession`; task value defined in `live_sync.rs` |
| One cycle transition                     | No stored state                                 | Acquire owner gate for call; clone current; run; install success                       | Error/terminal classification outside reusable transition | `cycle.rs`                                          |
| SSE frame parsing                        | Parser buffer                                   | Created per connected stream, dropped on reconnect                                     | Frame extraction                                          | `event_stream.rs`                                   |
| Live stream scheduling                   | Receivers, interval, deadlines, current backoff | Spawned by owner; exits on terminal/cancel; reconnect loop is intentionally long-lived | Deadline/backoff calculations                             | `live_sync.rs`                                      |
| Connection/key setup                     | No module state                                 | One connect/resume operation                                                           | Error translation/state assembly around explicit I/O      | `connect.rs`                                        |

Dependency direction:

```text
FFI / Tauri / acceptance consumers
                 |
                 v
        session/mod.rs (sole owner/facade)
          |        |          |
          v        v          v
       connect   cycle <--- live_sync ---> event_stream
          |        |          |
          v        v          v
       server   sync/mod.rs   server SSE response
          \       |         /
             checkpoint/core
```

Children receive explicit state/gate/dependencies from the facade. They do not import shells,
discover global state, cache clients ambiently, or own a second durable session.

## Comments

Gate A group dispositions:

| Comment group/path | Keep | Move to spec | Move to learning | Delete | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `session/mod.rs` doc comment on `stop_live_and_wait` | Yes, wording may be tightened | No | No | No | Caller obligation and vault/cycle ordering are not fully expressed by the method name. |
| Existing production comments in `connect.rs` / `event_stream.rs` | N/A (none) | No | No | No | Names/types/structure currently suffice. |
| Required live scheduler comments | Only comments explaining doorbell/safety/retry/cancellation ordering that remains non-obvious after extraction | Product timing remains in `sync.md` | Historical rationale stays in this ledger | Narrative comments | Poll/retry/background ordering is an allowed comment category. |
| `session/mod.rs` test comments | Keep only staged request/response or crash/failure ordering landmarks | No | Historical incident prose belongs here/spec | Syntax narration | Test fixture ordering can be hard to infer. |
| `tests/sse_live.rs` comments describing the “new trait replacing old LiveHandle” | No | No | If historically useful, this ledger already captures it | Yes | Author-history narration is stale and not contract information. |
| Acceptance-suite staged scenario comments | Yes where they explain ordering/data-safety setup | Product requirements already live in `sync.md` | Historical incidents already documented | Redundant narration only | These unchanged test comments explain why staged operations matter. |

Before Gate B, every retained or added comment in changed production files will be listed by
path/line with the non-obvious information it adds. This Gate A grouping does not substitute for
that complete census.

Baseline production-comment census: the complete in-scope search found exactly one source comment,
`session/mod.rs:188`, the `stop_live_and_wait` caller-ordering doc comment listed above;
`connect.rs` and `event_stream.rs` contain none. Unchanged assembled acceptance files remain outside
the structural rewrite and retain only their existing staged-operation/section comments.

## Tests

- Fast tests remain inline with their real owner: facade lifecycle tests in `mod.rs`,
  checkpoint/state-transition tests in `cycle.rs`, SSE framing tests in `event_stream.rs`.
- No private factory is exported for testing and no `tests.rs` translation warehouse is created.
- Real-server, SSE, cross-platform, and FFI tests stay at their assembled boundaries.
- No timeout, assertion, ignored annotation, failure path, or error classification is loosened.
- Final verification will rerun the exact focused/isolated baseline commands, `cargo test -p
futo-notes-tauri --lib`, and the repository's maximal `just prepush` gate (`just check`, full Rust
  workspace, full Playwright, and cross-platform sync). Any changed public/FFI surface would
  additionally trigger binding regeneration and both native builds, but Gate A proposes no such
  change.

## Consumer and documentation disposition

| Consumer/boundary                              | Dependency on session                                                                              | Planned migration/change                                                                                                                 | Gate C evidence                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `crates/futo-notes-sync/src/lib.rs`            | Re-exports session contract and hidden compatibility calls into `session::connect`/canonical cycle | No semantic or source change expected; private module declarations update only inside `session/mod.rs`                                   | Public-surface diff + sync crate tests                              |
| `futo-notes-ffi/src/sync/client.rs`            | Wraps every public session lifecycle method                                                        | No migration; signatures stay frozen                                                                                                     | `cargo test -p futo-notes-ffi`                                      |
| `futo-notes-ffi/src/sync/events.rs`            | Projects listener callbacks to UniFFI                                                              | No migration; callback semantics stay frozen                                                                                             | FFI sync contract + native compile only if visible diff occurs      |
| `apps/tauri/.../sync/cycle_runner.rs`          | Runs manual cycle and starts live with watcher suppression                                         | No migration; pre-write registration remains before sync writes                                                                          | Tauri lib tests + workspace tests                                   |
| `apps/tauri/.../sync/tauri_commands.rs`        | Connect/resume/disconnect/status/sync/live/note-changed command projection                         | No migration; command names/input/output frozen                                                                                          | Tauri lib tests + `just check` contract check                       |
| `apps/tauri/.../sync/tauri_events.rs`          | Distinguishes connected/reconnecting/cycle-error/stopped callbacks                                 | No migration; callback classification frozen                                                                                             | Tauri compile/tests + semantic diff                                 |
| Native Swift/Kotlin callers/generated bindings | Consume the unchanged UniFFI `SyncClient` surface                                                  | No hand edit/regeneration when semantic API diff is empty                                                                                | FFI semantic-shape test; native builds only if visible diff appears |
| External sync server                           | Supplies auth/key/object/blob/SSE protocol                                                         | No server or wire change                                                                                                                 | Isolated server + SSE suites                                        |
| `docs/spec/sync.md`                            | Behavioral and current internal ownership authority                                                | Preserve behavior; at Gate C update only structural module references if the approved tree makes the existing generic wording incomplete | Spec diff + `just spec-gaps-check`/`just check`                     |
| This ledger                                    | Durable design, approvals, evidence, comment census, accounting                                    | Maintain after every gate                                                                                                                | No pending/blank final rows at Gate C                               |

## Semantic-change decision lane

None proposed. Any later product/API/protocol/persisted-format change requires its own row and
explicit approval before implementation.

| Surface change | Explicit product/spec authority | Why architecture requires it | Data reconstructible? | Safety/lifecycle impact | Consumer migration | User decision |
| -------------- | ------------------------------- | ---------------------------- | --------------------- | ----------------------- | ------------------ | ------------- |

## Gate B architecture checkpoint

### User guidance and revised refinement

The first Gate B packet was not approved. The user found the result still hard to read and noted
that behavior had not been broken into enough clean, precisely named functions. Source review
confirmed the concern: `live_sync.rs` remained a 262-line implementation unit;
`run_connected_stream` took ten parameters and mixed catch-up, four scheduling triggers, event
decoding, read failure classification, and stream termination; the generic `run` mixed snapshot
access, client creation, stream connection, auth termination, retry policy, callback emission, and
task shutdown.

The user-directed Gate B refinement replaces that concentration with this capability tree:

| Revised path                       | Precise responsibility                                                                                                                                 | Named orchestration phases                                                                   | State                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `session/live/mod.rs`              | Live task spawn/notification/stop boundary used by `SyncSession`.                                                                                      | `spawn_live_task`, `notify_note_changed`, `stop`                                             | Channel senders and abort handle stored only in owner-held `LiveTask`.                         |
| `session/live/runner.rs`           | Outer task lifecycle: obtain current client, connect the SSE stream, classify terminal/retry outcomes, wait with backoff, emit stopped.                | `run_live_task`, `connect_event_stream`, `wait_for_reconnect`                                | Task-local receivers/backoff only.                                                             |
| `session/live/connected_stream.rs` | One authenticated stream: immediate catch-up, local-push/remote-pull deadlines, safety polling, framed event reads, and cycle callback classification. | `run_connected_stream`, `run_cycle_and_notify`, `read_stream_events`, `schedule_remote_pull` | Connection-local deadlines/parser/interval; borrows task signals and session-owned state/gate. |
| `session/live/event_stream.rs`     | Convert arbitrary SSE byte chunks into named events.                                                                                                   | `push`                                                                                       | Parser-local incomplete-frame buffer only.                                                     |

This changes module layout and private names only. `SyncSession` remains the sole durable mutable
state/lifecycle owner, product semantics stay frozen, and no external or generated surface changes.

### First Gate B packet (rejected historical evidence)

Gate A was implemented without amendment. The complete approved skeleton was created before
substantial behavior moved, and `cargo check -p futo-notes-sync` passed with that skeleton. First
public green was then reached inside the approved ownership model; there was no transitional
production or test warehouse.

### Actual tree after first green

| Actual path               | Production | Test | Single responsibility                                                                                                                                  | Mutable state/lifecycle                                                                  |
| ------------------------- | ---------: | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `session/mod.rs`          |        153 |   53 | Public session contract and top-down orchestration.                                                                                                    | Sole owner of connected state, the cycle gate, and registered live task.                 |
| `session/connect.rs`      |        155 |    0 | Establish/resume an authenticated encrypted connection and construct initial state.                                                                    | No stored state; explicit remote, checkpoint, and blocking-crypto effects.               |
| `session/cycle.rs`        |         38 |  346 | Run one gated canonical cycle and install returned in-memory progress.                                                                                 | No ambient state; borrows owner-held state/gate for one operation.                       |
| `session/live_sync.rs`    |        262 |    0 | Run the cohesive live SSE state machine: task signals, catch-up, deadlines, safety poll, reconnect/backoff, cancellation, and callback classification. | Runner-local channels/timers/backoff only; `LiveTask` is stored solely by `SyncSession`. |
| `session/event_stream.rs` |         24 |   44 | Incrementally frame named SSE events across arbitrary chunks.                                                                                          | Parser-local incomplete-frame buffer only.                                               |

The 346 test lines in `cycle.rs` are the two retained checkpoint-failure promises plus their
cohesive raw-HTTP fault-injection fixture. They are six lines above the Gate A size prompt, but
splitting that one fixture would obscure its request ordering and fault contract. The 262-line
`live_sync.rs` remains one readable long-running state-machine sequence and is within its Gate A
prompt. No file was split or kept merely to satisfy a line target.

### Actual versus approved target

The path/responsibility diff is empty:

- all five approved files exist under the session owner;
- `mod.rs` contains the public contract, three owner fields, and orchestration rather than the
  live protocol implementation;
- `cycle.rs` owns the gate/clone/canonical-cycle/install transition and its fault tests;
- `live_sync.rs` owns the complete live runner without durable or ambient module state;
- `connect.rs` and `event_stream.rs` were reused unchanged as conforming capabilities;
- the former private `LiveContext`, `LiveInputs`, `CycleResult`, `StreamResult`,
  `cycle_stopped`, `sync_with_checkpoint`, and root live helpers are absent.

No genuinely emergent extraction, merge, rename, co-location, or deletion is proposed at Gate B.
Further splitting would create one-function files or fragment the connected-stream narrative.

Implementation provenance also matches Gate A: `mod.rs` is a contract rewrite; `cycle.rs` and
`live_sync.rs` are new implementations from the captured contract; `connect.rs` and
`event_stream.rs` are conforming reuse. The old center was not moved wholesale.

### State, dependency, compatibility, and tests

- `SyncSession` remains the sole lifecycle owner. Children receive explicit `Arc<Mutex<...>>`,
  paths, callbacks, and hooks; no global/static mutable session state or cached client was added.
- Dependency flow remains consumer → `session/mod.rs` → `connect`/`cycle`/`live_sync`, with
  `live_sync` using `cycle` and `event_stream`; children depend only on lower sync/server/core
  owners and never on FFI, Tauri, or UI code.
- Every manual, catch-up, SSE, safety, and local-change trigger reaches the same `cycle::run`,
  which calls the canonical push-first `sync::cycle_with_checkpoint` under the one gate and
  installs returned progress before reporting success.
- The extracted public-surface comparison (`pub` declarations/methods before versus after) is
  empty. FFI and Tauri contract tests pass. No generated artifact, wire/persisted shape, callback,
  error, timing rule, or public method changed.
- Facade lifecycle tests stay in `mod.rs`; checkpoint transition/fault tests moved with their
  owner to `cycle.rs`; SSE parser tests remain in `event_stream.rs`; assembled server, SSE,
  cross-platform, FFI, and Tauri tests remain at their distinct boundaries. No private factory or
  translated-test warehouse was introduced.

### Changed-production comment census

The complete census contains one retained comment:

| Path/line                                                | Disposition | Information beyond names/types/structure/spec                                                                                                                                                              |
| -------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/mod.rs:147` doc comment on `stop_live_and_wait` | Keep        | States the caller-critical ordering guarantee that stopping the task is followed by waiting for any cycle already holding the vault; the method name alone does not say it quiesces the shared vault gate. |

`connect.rs`, `cycle.rs`, `live_sync.rs`, and `event_stream.rs` contain no production comments.
The stale historical `LiveHandle` narrative in `tests/sse_live.rs` was deleted. No product
requirement was moved into a source comment.

### First-green verification and accounting

| Evidence                                                     | Gate B result                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skeleton `cargo check -p futo-notes-sync`                    | Pass before substantive implementation.                                                                                                                                       |
| `cargo test -p futo-notes-sync`                              | Pass: 55/55 default tests; 25 server and 2 SSE cases enumerated as ignored by the default command. Reconfirmed after the latest resume.                                       |
| Isolated dev-auth server integration command on port 3108    | Cargo 25/25 pass; 24 substantive cases. Small-blob oversize case returned early because `FUTO_TEST_SMALL_BLOB_SERVER` was unavailable.                                        |
| Isolated SSE command on port 3108                            | Pass 2/2.                                                                                                                                                                     |
| `just test-cross-platform` with the selected server checkout | Pass 30/30, 0 failed, 0 skipped, 111,709 ms.                                                                                                                                  |
| `cargo test -p futo-notes-ffi`                               | Pass: 4/4 note-contract + 2/2 sync-contract tests.                                                                                                                            |
| `cargo test -p futo-notes-tauri --lib`                       | Pass: 26 passed, 0 failed, 1 ignored real OS secret-store test.                                                                                                               |
| Targeted `rustfmt --check` for all five session files        | Pass.                                                                                                                                                                         |
| `git diff --check`                                           | Pass.                                                                                                                                                                         |
| Public `pub` declaration/method extraction diff              | Empty.                                                                                                                                                                        |
| Full `cargo fmt --all -- --check`                            | Fails on unrelated pre-existing formatting in model/search/store and existing sync tests; no unrelated file was reformatted. All changed Rust files pass targeted formatting. |

The isolated server was stopped after verification. Its rewrite-owned database and blob directory
were removed; no demo/production server or user data was touched.

Repeatable accounting using the same helper and scope as Gate A:

| Metric                | Baseline | Gate B |       Delta |
| --------------------- | -------: | -----: | ----------: |
| Production lines      |      607 |    632 | +25 (+4.1%) |
| Test lines            |    4,013 |  4,058 | +45 (+1.1%) |
| Source files          |        7 |      9 |          +2 |
| Files with production |        3 |      5 |          +2 |

The production increase buys two explicit capability boundaries and a facade that no longer
contains the 228-line live state machine. The change reduces the largest mixed center from 428
production + 351 test lines to a 153-production/53-test facade while keeping the cohesive live
sequence intact. Counts are evidence, not the reason for the split.

### Gate B compliance reconciliation

The Gate A matrix below remains the historical imported requirement inventory. This overlay records
the implementation evidence that applied to the rejected first Gate B; the authoritative completed
Gate C evidence appears after that historical matrix.
Every applicable row is **Implemented** at Gate B, and every N/A row keeps its scope-specific
reason. There are no failed or structurally unresolved Gate B rows.

| Matrix requirement group                                  | Gate B implementation evidence                                                                                                                                   | Gate B status |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Semantic classification/freeze/results                    | Contract-disposition table retained; public extraction diff empty; FFI/Tauri contracts green; semantic-change lane empty.                                        | Implemented   |
| Binding tree/provenance/no warehouses                     | Actual five-file tree and provenance match Gate A; skeleton compiled first; old private center symbols absent; tests co-located by owner.                        | Implemented   |
| State/lifecycle/background safety                         | Only `SyncSession` owns durable state/gate/live registration; runner state is local; all work remains spawned/async with explicit cancellation.                  | Implemented   |
| Push-first/checkpoint/live/disconnect protocol            | All triggers delegate through `cycle::run` to canonical cycle; focused, isolated server/SSE, and cross-platform suites are green.                                | Implemented   |
| Ownership/dependency/import/visibility                    | All new code is private under `session/`; dependency flow is inward; no shell/UI/global imports or new dependency exists.                                        | Implemented   |
| Naming/file/function design                               | Domain names identify cycle/live/event capabilities; facade reads as orchestration; cohesive live sequence retained; no generic helper/manager/data module.      | Implemented   |
| Comments/specs/structural completeness                    | Complete one-comment census; stale historical test comment removed; no behavioral spec change or stale production symbol/path found.                             | Implemented   |
| Verification/non-vacuity/accounting                       | 55 default tests, 24 substantive isolated server cases, 2 SSE, 30 cross-platform, 6 FFI, and 26 Tauri tests pass; exact skip/ignore and accounting are recorded. | Implemented   |
| UI/component/HTTP-route/operational-script checklist rows | N/A for this private Rust session scope, for the concrete reasons retained in the full matrix.                                                                   | N/A           |

Gate C still requires final cleanup/review, a fresh full-authority review required by the workflow,
the repository-wide required verification chain, final per-invariant guards, and conversion of the
full matrix from `Planned`/`Implemented` to `Pass`/justified `N/A`.

### Revised Gate B packet after readability refinement

The user-requested refinement is implemented and public behavior is green again. The current tree
is the Gate B candidate; the rejected first packet above is retained only as decision history.

| Current path                       | Production | Test | Responsibility                                                                                          |
| ---------------------------------- | ---------: | ---: | ------------------------------------------------------------------------------------------------------- |
| `session/mod.rs`                   |        152 |   53 | Public contract, sole durable state/lifecycle ownership, and orchestration.                             |
| `session/connect.rs`               |        155 |    0 | Establish/resume authenticated encrypted state.                                                         |
| `session/cycle.rs`                 |         38 |  346 | One serialized canonical push-first cycle and its checkpoint fault tests.                               |
| `session/live/mod.rs`              |         56 |    0 | Spawn/notify/stop boundary for the one owner-registered live task.                                      |
| `session/live/runner.rs`           |        129 |    0 | Connect/reconnect/terminal-error/stopped orchestration for the background task.                         |
| `session/live/connected_stream.rs` |        179 |    0 | One authenticated stream's catch-up, deadlines, safety polling, event reads, and cycle callback policy. |
| `session/live/event_stream.rs`     |         24 |   44 | SSE byte-chunk framing with its four parser promises.                                                   |

The former 262-line `live_sync.rs` and ten-parameter `run_connected_stream` are gone. The current
production narratives are broken into these named phases:

| Function               | Approximate span | What its name lets the caller understand without opening it                                                                |
| ---------------------- | ---------------: | -------------------------------------------------------------------------------------------------------------------------- |
| `spawn_live_task`      |         24 lines | Create bounded task signals, spawn the runner, and return the registered handle.                                           |
| `run_live_task`        |         55 lines | Own the outer background lifecycle and compose connection, one-stream work, retry, and stopped notification.               |
| `connect_event_stream` |         31 lines | Build the current authenticated client and classify connected/retry/terminal outcomes.                                     |
| `wait_for_reconnect`   |         11 lines | Wait cancelably and advance bounded exponential backoff.                                                                   |
| `run_connected_stream` |         51 lines | Run immediate catch-up and arbitrate the four clearly visible stream triggers. It now takes five cohesive inputs, not ten. |
| `run_cycle_and_notify` |         25 lines | Execute the canonical cycle, emit the rich summary/error callback, and classify collection-gone as terminal.               |
| `read_stream_events`   |         10 lines | Read one bounded chunk and translate EOF/read/idle outcomes into stable messages.                                          |
| `schedule_remote_pull` |          7 lines | Treat only `ready`/`change` as debounced pull doorbells.                                                                   |
| `wait_until_scheduled` |          5 lines | Turn an optional deadline into a selectable timer.                                                                         |

`LiveCycle` is a narrow borrowed capability containing only the dependencies required to execute
and report a live-triggered cycle. `LiveSchedule` contains only task-local safety/push deadlines.
Neither stores a second connected state, gate, client, task registration, or ambient mutable
value; `SyncSession` remains the sole durable owner.

Current accounting, using separate bundled-helper snapshots because the helper cannot compare an
unstaged deleted path with its replacement path in one invocation:

| Metric                | Baseline | Revised Gate B |         Delta |
| --------------------- | -------: | -------------: | ------------: |
| Production lines      |      607 |            733 | +126 (+20.8%) |
| Test lines            |    4,013 |          4,058 |   +45 (+1.1%) |
| Source files          |        7 |             11 |            +4 |
| Files with production |        3 |              7 |            +4 |

The additional production code is explicit naming and dependency/lifecycle structure. It removes
the largest cognitive warehouse rather than pursuing LOC reduction: no current production file
exceeds 179 lines, and every file/function above has one discoverable role. There are no generic
helpers, one-function files, duplicate protocol decisions, or new shared/global abstractions.

Current verification after the refinement:

| Command/evidence                                  | Result                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cargo check -p futo-notes-sync`                  | Pass.                                                                                                            |
| `cargo test -p futo-notes-sync`                   | 55/55 default tests pass; 25 server and 2 SSE tests remain explicitly ignored by the default command.            |
| Isolated dev-auth server integration on port 3109 | Cargo 25/25 green; 24 substantive cases, with the small-blob case retaining its environment early-return caveat. |
| Isolated SSE integration on port 3109             | 2/2 pass.                                                                                                        |
| `just test-cross-platform`                        | 30/30 pass, 0 failed/skipped, 141,322 ms.                                                                        |
| `cargo test -p futo-notes-ffi`                    | 4/4 note-contract + 2/2 sync-contract pass.                                                                      |
| `cargo test -p futo-notes-tauri --lib`            | 26 pass, 0 fail, 1 ignored real OS secret-store test.                                                            |
| Public `pub` extraction diff                      | Empty.                                                                                                           |

The isolated readability-test server was stopped, and its owned database/blob directory were
removed. The complete changed-production comment census is still exactly the one retained
`stop_live_and_wait` ordering comment in `session/mod.rs`; all new live modules contain no source
comments because their names and structure carry the explanation.

Revised Gate B compliance reconciliation: every applicable Gate B row was **Implemented** with
the stronger current evidence above. In particular, the module-root/orchestration, coherent
narrative, dense-operation naming, narrowest-owner, non-fragmentation, state-owner, test-placement,
comment, non-vacuity, and compatibility rows now point to the revised seven-production-file tree
and named-function table. No semantic-surface or generated-boundary row changed. The user approved
this revised architecture for merge; the completed Gate C reconciliation follows below.

## Gate A design-stage requirement-to-evidence matrix (historical snapshot)

This table preserves the evidence plan that was approved at Gate A. Its `Planned` statuses are a
historical record, not the final compliance result. The authoritative Gate C matrix follows it and
contains only `Pass` or scope-justified `N/A` statuses.

| Source + section                                       | Requirement                                                                                                             | Applies? / N/A reason                                                                         | Gate A planned evidence                                                                  | Gate B implementation evidence             | Gate C verified evidence                               | Status  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ------- |
| Guided mandatory                                       | Semantic surfaces are classified separately from private mechanisms and generated artifacts.                            | Applies                                                                                       | Complete contract-disposition table above                                                | Pending                                    | Pending                                                | Planned |
| Guided mandatory                                       | Product semantic contract is frozen by default.                                                                         | Applies                                                                                       | Frozen-contract statement + surface table                                                | Pending                                    | Pending                                                | Planned |
| Guided mandatory                                       | No semantic deletion/signature/data reduction relies only on absent callers.                                            | Applies                                                                                       | Empty semantic-change lane; any later item needs individual approval                     | Pending                                    | Pending                                                | Planned |
| Guided mandatory                                       | Non-reconstructible operation results are preserved unless explicitly changed.                                          | Applies                                                                                       | Full `SyncSummary`/`ConnectInfo`/status disposition                                      | Pending                                    | Pending                                                | Planned |
| Guided mandatory                                       | Gate A target tree is binding from first compile.                                                                       | Applies                                                                                       | Target tree/provenance table                                                             | Pending actual-vs-approved diff            | Pending                                                | Planned |
| Guided mandatory                                       | No legacy center is moved wholesale into a new owner.                                                                   | Applies                                                                                       | `mod.rs`, `cycle.rs`, `live_sync.rs` all marked rewrite/new, never move                  | Pending diff review                        | Pending                                                | Planned |
| Guided mandatory                                       | No planned capability remains inside a broad root/lifecycle owner at Gate B.                                            | Applies                                                                                       | Facade/cycle/live responsibility split                                                   | Pending per-file audit                     | Pending                                                | Planned |
| Guided mandatory                                       | No translated-test warehouse replaces the old test warehouse.                                                           | Applies                                                                                       | Tests co-located by owner; no `tests.rs` target                                          | Pending test-location map                  | Pending                                                | Planned |
| Guided mandatory                                       | Every legacy promise has one disposition and named final guard.                                                         | Applies                                                                                       | Nine-row ledger, counts reconciled                                                       | Pending                                    | Pending                                                | Planned |
| Guided mandatory                                       | Comments add information beyond names/types/structure/specs.                                                            | Applies                                                                                       | Gate A group disposition                                                                 | Pending complete changed-production census | Pending                                                | Planned |
| Guided mandatory                                       | Every applicable organization/refactoring checklist item is evidenced.                                                  | Applies                                                                                       | Remaining rows in this matrix                                                            | Pending                                    | Pending                                                | Planned |
| Guided mandatory                                       | Every scoped safety/spec requirement is guarded.                                                                        | Applies                                                                                       | S1–S17 invariant map                                                                     | Pending                                    | Pending named final guards                             | Planned |
| Guided mandatory                                       | Default and acceptance commands execute meaningful nonzero coverage.                                                    | Applies                                                                                       | Exact baseline counts and oversize skip disclosure                                       | Pending                                    | Pending rerun counts                                   | Planned |
| Guided mandatory                                       | Every consumer and generated boundary is verified.                                                                      | Applies                                                                                       | Consumer matrix                                                                          | Pending                                    | Pending command evidence                               | Planned |
| Guided mandatory                                       | Production/test accounting is separate and reproducible.                                                                | Applies                                                                                       | Helper command, heuristic, inspected 607/4,013 split                                     | Pending                                    | Pending baseline/final report                          | Planned |
| Root AGENTS modifying-agent standard                   | Read full organization/spec/nested instructions and name narrowest owner before planning/editing.                       | Applies                                                                                       | Authority list + session owner statement                                                 | Same lease unless invalidated              | Reread as required before completion                   | Planned |
| Root M5                                                | Sync/background work must not block or delay typing.                                                                    | Applies                                                                                       | S17; live work remains spawned/async, crypto blocking-worker                             | Pending source audit                       | Full consumer/acceptance verification                  | Planned |
| Root M11/M18                                           | No silent green; report exact nonzero counts and complete required chain.                                               | Applies                                                                                       | Baseline log includes skips and failed setup                                             | Pending                                    | Final command/count table                              | Planned |
| Root M15                                               | Do not loosen timeouts/assertions/error handling to get green.                                                          | Applies                                                                                       | Test disposition says unchanged                                                          | Pending diff review                        | Final diff/test review                                 | Planned |
| Root M17                                               | Search sibling occurrences after changes.                                                                               | Applies                                                                                       | Whole session/caller inventory                                                           | Pending old-symbol/path searches           | Final `rg` evidence                                    | Planned |
| Root M19                                               | Behavioral spec remains current.                                                                                        | Applies                                                                                       | `sync.md` read; structural-only update disposition                                       | Pending spec diff                          | `just spec-gaps-check` via `just check`                | Planned |
| Root §7.5                                              | `cargo test -p futo-notes-sync` green.                                                                                  | Applies                                                                                       | 55/55 baseline                                                                           | Pending                                    | Final exact result                                     | Planned |
| Root §7.5                                              | Protocol/engine changes require cross-platform scenario and run.                                                        | Applies as verification; no protocol/engine semantic change proposed                          | Existing 30 scenarios, 30/30 baseline                                                    | Pending                                    | Final `just test-cross-platform`                       | Planned |
| Root §7.5                                              | Server-contract changes require isolated F-series tests, never demo server.                                             | Applies as verification; no server change proposed                                            | Isolated dev-auth 24 substantive passes                                                  | Pending                                    | Final isolated server/SSE results                      | Planned |
| Root §7.5                                              | Push-first invariant remains untouched.                                                                                 | Applies, CRITICAL                                                                             | S3 + F1 named guards                                                                     | Pending cycle call-path audit              | Final F1/cross-platform evidence                       | Planned |
| Root §7.10                                             | `just check`, full Rust workspace, full Playwright, and cross-platform sync pass before completion.                     | Applies                                                                                       | Final `just prepush` verification plan                                                   | Pending                                    | Final `just prepush` with component counts/results     | Planned |
| `sync.md` ownership                                    | All sync logic remains in Rust; one session owns connection state, cycles, and live task.                               | Applies                                                                                       | Target state/owner map                                                                   | Pending                                    | Source/consumer audit                                  | Planned |
| `sync.md` push-first                                   | All manual/live/debounced triggers run the same full push-first cycle.                                                  | Applies                                                                                       | S3 + target `cycle.rs`                                                                   | Pending                                    | F1 + cross-platform                                    | Planned |
| `sync.md` checkpoint failure                           | Final checkpoint failure retains successful in-memory progress and reports once.                                        | Applies                                                                                       | S5 + two Fast promises                                                                   | Pending                                    | Final two test results                                 | Planned |
| `sync.md` live SSE                                     | Ready/change doorbell, immediate catch-up, 45 s safety, reconnect/backoff remain.                                       | Applies                                                                                       | S10–S12 + scheduler inventory                                                            | Pending                                    | SSE/cross-platform evidence                            | Planned |
| `sync.md` callback fidelity                            | Rich summary, cycle-error versus stream-error, and stopped callback remain distinct.                                    | Applies                                                                                       | Listener surface/error table                                                             | Pending                                    | FFI/Tauri tests and source audit                       | Planned |
| `sync.md` disconnect                                   | Disconnect demotes to ancestry and reconnect reconciles safely.                                                         | Applies                                                                                       | S15                                                                                      | Pending                                    | Three server + peer-delete scenarios                   | Planned |
| `sync.md` storage migration                            | Stop live and await cycle gate before vault migration.                                                                  | Applies                                                                                       | S4 + target owner                                                                        | Pending                                    | Fast test + Android consumer compile if visible change | Planned |
| `sync.md` E2EE/wire                                    | Client-side encryption and server/wire compatibility remain unchanged.                                                  | Applies                                                                                       | External-contract freeze                                                                 | Pending semantic diff                      | Real-server/FFI evidence                               | Planned |
| Organization + Refactoring checklist: Structure        | Code grouped under its owning feature/resource/provider.                                                                | Applies                                                                                       | Entire target under `session/`                                                           | Pending actual tree                        | Final tree audit                                       | Planned |
| Organization + Refactoring checklist: Structure        | Cohesive capability files grouped in descriptively named module folder.                                                 | Applies                                                                                       | `session/{connect,cycle,live_sync,event_stream}`                                         | Pending                                    | Final tree audit                                       | Planned |
| Organization + Refactoring checklist: Structure        | Module entry point exposes/orchestrates instead of containing every detail.                                             | Applies                                                                                       | `session/mod.rs` target responsibility                                                   | Pending per-file audit                     | Final source audit                                     | Planned |
| Organization + Refactoring checklist: Structure        | Feature-private helpers remain local.                                                                                   | Applies                                                                                       | All new helpers private within session children                                          | Pending visibility audit                   | Final `pub`/import audit                               | Planned |
| Organization + Refactoring checklist: Structure        | Shared code has real independent consumers.                                                                             | Applies                                                                                       | No new shared/global module; only existing public facade shared                          | Pending                                    | Final dependency audit                                 | Planned |
| Organization + Refactoring checklist: Structure        | API implementations delegate to route-local helpers where appropriate.                                                  | N/A: no HTTP route/controller implementation is changed; `server.rs` is external collaborator | N/A reason recorded                                                                      | N/A                                        | N/A                                                    | N/A     |
| Organization + Refactoring checklist: Structure        | Cross-feature domain types shared; local types stay local.                                                              | Applies                                                                                       | Public semantic types remain existing crate owners; live private types stay local        | Pending                                    | Final type/visibility audit                            | Planned |
| Organization + Refactoring checklist: Structure        | Tests co-located with owned behavior.                                                                                   | Applies                                                                                       | Facade/cycle/parser placement map                                                        | Pending                                    | Final test path audit                                  | Planned |
| Organization + Refactoring checklist: Structure        | Imports respect ownership boundaries.                                                                                   | Applies                                                                                       | Explicit dependency diagram                                                              | Pending                                    | Final import audit                                     | Planned |
| Organization + Refactoring checklist: Structure        | Concrete modules imported directly except deliberate public facade.                                                     | Applies                                                                                       | Child modules concrete/private; consumers use crate facade                               | Pending                                    | Final import/re-export audit                           | Planned |
| Organization + Refactoring checklist: Structure        | Technical folders exist only where clearer.                                                                             | Applies                                                                                       | Existing domain `session/`; no `helpers/common/manager` folder                           | Pending                                    | Final tree audit                                       | Planned |
| Organization + Refactoring checklist: Structure        | Layout not fragmented merely to minimize files.                                                                         | Applies                                                                                       | Only two real capability modules added; cohesive live sequence retained                  | Pending line/responsibility audit          | Final audit/accounting                                 | Planned |
| Organization + Refactoring checklist: Naming           | Files and exports share semantic names.                                                                                 | Applies                                                                                       | `cycle`, `live_sync`, existing connect/event stream                                      | Pending                                    | Final name/path audit                                  | Planned |
| Organization + Refactoring checklist: Naming           | Functions use precise verb-and-noun names.                                                                              | Applies                                                                                       | Function inventory supplies target verbs                                                 | Pending                                    | Final symbol audit                                     | Planned |
| Organization + Refactoring checklist: Naming           | Components use role-oriented PascalCase names.                                                                          | N/A: Rust session scope has no UI components                                                  | N/A reason recorded                                                                      | N/A                                        | N/A                                                    | N/A     |
| Organization + Refactoring checklist: Naming           | Booleans read as claims.                                                                                                | Applies                                                                                       | Avoid boolean wrappers where enum outcome is clearer; any booleans claim state           | Pending                                    | Final symbol audit                                     | Planned |
| Organization + Refactoring checklist: Naming           | Types describe domain concepts/boundary roles.                                                                          | Applies                                                                                       | `SyncSession`, `LiveTask`, precise outcomes/inputs                                       | Pending                                    | Final type audit                                       | Planned |
| Organization + Refactoring checklist: Naming           | No vague helper/manager/processor/data names.                                                                           | Applies                                                                                       | Target tree contains none                                                                | Pending                                    | Final `rg`/review                                      | Planned |
| Organization + Refactoring checklist: Naming           | Paths make sense without opening files.                                                                                 | Applies                                                                                       | Target tree responsibility table                                                         | Pending                                    | Gate B user review + final audit                       | Planned |
| Organization + Refactoring checklist: Naming           | Established/contractual abbreviations remain intact.                                                                    | Applies                                                                                       | `sync`, `SSE`, `E2EE`, HTTP names preserved                                              | Pending                                    | Semantic/path diff                                     | Planned |
| Organization + Refactoring checklist: Components/state | Pages coordinate; children render; explicit minimal props; loading/error states; immutable UI updates; effects cleanup. | N/A: no page/component/UI/effect code in declared scope                                       | N/A reason recorded                                                                      | N/A                                        | N/A                                                    | N/A     |
| Organization + Refactoring checklist: Components/state | Shared mutable state scoped to smallest useful owner.                                                                   | Applies                                                                                       | Sole `SyncSession` state/lifecycle owner                                                 | Pending state audit                        | Final state-owner audit                                | Planned |
| Organization + Refactoring checklist: Functions        | Separate pure transformations from effects when clearer/testable.                                                       | Applies                                                                                       | SSE parser already separate; live/cycle effectful sequences explicit                     | Pending                                    | Final function audit                                   | Planned |
| Organization + Refactoring checklist: Functions        | Parent functions read as coherent narratives at one abstraction level.                                                  | Applies                                                                                       | Facade/live target responsibilities                                                      | Pending                                    | Gate B per-function audit                              | Planned |
| Organization + Refactoring checklist: Functions        | Dense policies/substantial branches use descriptive helpers when they interrupt flow.                                   | Applies                                                                                       | Error/reconnect/cycle operations named                                                   | Pending                                    | Final function audit                                   | Planned |
| Organization + Refactoring checklist: Functions        | Simple branches remain inline when extraction adds indirection.                                                         | Applies                                                                                       | Target rejects symmetric micro-helpers                                                   | Pending                                    | Final function audit                                   | Planned |
| Organization + Refactoring checklist: Functions        | Helpers not created for symmetry/LOC/purity alone.                                                                      | Applies                                                                                       | Each target module has stable responsibility                                             | Pending provenance audit                   | Final audit/accounting                                 | Planned |
| Organization + Refactoring checklist: Functions        | Multi-step operations read top to bottom.                                                                               | Applies                                                                                       | Protocol sequence table defines narratives                                               | Pending                                    | Final source audit                                     | Planned |
| Organization + Refactoring checklist: Functions        | Required async work is awaited.                                                                                         | Applies                                                                                       | Ordering/cancellation inventory                                                          | Pending compiler/source audit              | Tests + source review                                  | Planned |
| Organization + Refactoring checklist: Functions        | Inputs validated at trust boundaries.                                                                                   | Applies                                                                                       | Existing `connect.rs`/`server.rs` boundaries reused unchanged                            | Pending                                    | Real-server tests                                      | Planned |
| Organization + Refactoring checklist: Functions        | Low-level errors gain context; boundary errors translate safely.                                                        | Applies                                                                                       | Frozen error table                                                                       | Pending                                    | FFI/server tests + diff                                | Planned |
| Organization + Refactoring checklist: Functions        | External data normalized to application-owned shapes.                                                                   | Applies                                                                                       | Existing `Http`/`ConnectedState`/summary boundary unchanged                              | Pending                                    | Surface diff + server tests                            | Planned |
| Organization + Refactoring checklist: Functions        | Classes/instances only when instance semantics justify them.                                                            | Applies                                                                                       | `SyncSession` justified by durable state/lifecycle; other work uses functions/plain data | Pending                                    | Final type audit                                       | Planned |
| Organization + Refactoring checklist: Comments/specs   | Product behavior and acceptance criteria live in spec.                                                                  | Applies                                                                                       | `sync.md` is authority; ledger is architecture evidence                                  | Pending                                    | Final spec/comment census                              | Planned |
| Organization + Refactoring checklist: Comments/specs   | Comments explain non-obvious intent/sequence/constraints/major sections.                                                | Applies                                                                                       | Comment disposition table                                                                | Pending complete census                    | Final census                                           | Planned |
| Organization + Refactoring checklist: Comments/specs   | Embedded operational scripts have phase/readiness comments.                                                             | N/A: no operational script is modified                                                        | N/A reason recorded                                                                      | N/A                                        | N/A                                                    | N/A     |
| Organization + Refactoring checklist: Comments/specs   | Comments do not restate obvious code.                                                                                   | Applies                                                                                       | Delete stale LiveHandle narrative; audit additions                                       | Pending census                             | Final census                                           | Planned |
| Organization + Refactoring checklist: Comments/specs   | Dead code deleted, not commented out.                                                                                   | Applies                                                                                       | No compatibility forwarding/old center retained                                          | Pending diff                               | Final old-symbol search                                | Planned |
| Organization + Refactoring checklist: Comments/specs   | Comments remain accurate after change.                                                                                  | Applies                                                                                       | Comment group dispositions                                                               | Pending census                             | Final census/search                                    | Planned |
| Organization + Refactoring checklist: Comments/specs   | Docs/guidance/authority references reflect moves/renames.                                                               | Applies                                                                                       | Consumer/docs disposition                                                                | Pending repo search                        | Final `rg` + docs diff                                 | Planned |
| Organization + Refactoring checklist: Verification     | Relevant tests pass.                                                                                                    | Applies                                                                                       | Exact baseline and final chain                                                           | Pending focused runs                       | Final command matrix                                   | Planned |
| Organization + Refactoring checklist: Verification     | Type checking passes.                                                                                                   | Applies to repository consumer gate                                                           | `just check` plan includes TypeScript check; Rust compiler covers Rust types             | Pending                                    | Final `just check`                                     | Planned |
| Organization + Refactoring checklist: Verification     | Linting/formatting passes.                                                                                              | Applies                                                                                       | `just check` + `cargo fmt --check` plan                                                  | Pending                                    | Final command evidence                                 | Planned |
| Organization + Refactoring checklist: Verification     | New files are at narrowest scope.                                                                                       | Applies                                                                                       | New files only in `session/`                                                             | Pending                                    | Final tree audit                                       | Planned |
| Organization + Refactoring checklist: Verification     | Feature understandable boundary-inward through names/directories.                                                       | Applies                                                                                       | Dependency diagram/target responsibilities                                               | Pending Gate B review                      | Final architecture audit                               | Planned |
| Organization + Refactoring checklist: Verification     | Unused dependencies/obsolete internal compatibility removed.                                                            | Applies                                                                                       | No dependency addition planned; private old structs/helpers removed                      | Pending cargo/diff search                  | Final dependency/old-symbol audit                      | Planned |
| Organization + Refactoring checklist: Verification     | Supported commands/keys/formats/protocols/public surfaces remain compatible unless documented migration.                | Applies                                                                                       | Frozen surface table; no semantic decisions                                              | Pending semantic diff                      | Final public diff + consumer tests                     | Planned |

## Gate C final requirement-to-evidence matrix

The two organization standards carry the same architecture-review checklist. Rows are combined
only where the same source inspection or command necessarily proves both copies.

| Source + requirement | Final verified evidence | Status |
| --- | --- | --- |
| Guided: classify semantic surfaces, private mechanisms, and generated artifacts separately | The contract-disposition table classifies every public action/result/error/callback and every retired private live helper; no generated artifact is in scope. | Pass |
| Guided: freeze Product semantic contracts by default | The base/final `pub` extraction diff is empty; FFI, Tauri, server, SSE, and cross-platform consumers are green. | Pass |
| Guided: do not delete/reduce semantics because callers are absent | The semantic-change lane is empty; no exported method, field, error, callback, or result was removed or reduced. | Pass |
| Guided: preserve non-reconstructible results | `ConnectInfo`, `SyncSummary`, status snapshots, rich live summaries, and error callbacks retain their complete shapes. | Pass |
| Guided: bind the Gate A target tree from first compile | The approved skeleton compiled before behavior moved. The later user-requested Gate B refinement is recorded and yields the final seven-file tree below. | Pass |
| Guided: do not move the legacy center wholesale | Provenance is contract rewrite/new/conforming reuse; old `LiveContext`, `LiveInputs`, result enums, root live loop, and `sync_with_checkpoint` are absent. | Pass |
| Guided: no approved capability remains in a broad owner | `mod.rs` owns only public lifecycle/orchestration; cycle, live task, runner, connected stream, and framing each have one named owner. | Pass |
| Guided: no translated-test warehouse | Facade lifecycle tests remain in `mod.rs`, checkpoint-fault tests are in `cycle.rs`, parser tests are in `live/event_stream.rs`, and assembled tests remain at public boundaries. | Pass |
| Guided: every legacy promise has one disposition and guard | All 66 inventoried promises reconcile to 9 Fast, 50 Acceptance, and 7 Core rows; none is Obsolete or Follow-up. Final guards are named below. | Pass |
| Guided: comments add information beyond names/types/structure/spec | The complete census contains one retained `stop_live_and_wait` ordering comment; all live modules have no production comments, and the stale test narrative was removed. | Pass |
| Guided: every applicable organization/refactoring rule has evidence | The organization/refactoring rows below cover the full shared checklist, including explicit scope-based N/A rows. | Pass |
| Guided: every scoped safety/spec requirement is guarded | S1-S17 are mapped to named tests/scenarios and source audits below. | Pass |
| Guided: default and acceptance commands run meaningful nonzero coverage | Default sync ran 55 tests; isolated server ran 24 substantive cases, SSE 2, cross-platform 30, FFI 6, Tauri 26, workspace and Playwright suites ran nonzero counts. | Pass |
| Guided: verify every consumer/generated boundary | `just prepush` covered the workspace, generated checks, desktop consumer, web consumer, full E2E, and cross-platform sync; focused FFI/Tauri commands are also recorded. | Pass |
| Guided: separate reproducible production/test accounting | The bundled helper plus manual mixed-Rust inspection produced 607→733 production and 4,013→4,058 test lines. | Pass |
| Root modifying-agent/read-lease rules | Every required authority was re-read completely after each compaction; the declared owner remained `session/` and `SyncSession` remained the lifecycle owner. | Pass |
| Root M5: background sync cannot delay typing | Live work is spawned and async; no synchronous UI/per-keystroke path or new blocking operation was introduced; full E2E and cross-platform suites pass. | Pass |
| Root M11/M18: no silent green and complete verification | Exact counts, ignored cases, the small-blob early-return, and every command are reported below; `just prepush` exited 0. | Pass |
| Root M15: do not loosen tests/timeouts/errors | Diff review shows no loosened assertion, timeout, ignore, or error path; production timing constants and failure messages are preserved. | Pass |
| Root M17: search sibling occurrences | Final `rg` found no old live symbols or stale `session/event_stream` references in current source/spec files; this ledger intentionally retains the base path in historical inventory rows. | Pass |
| Root M19/spec discipline | No product behavior changed; `docs/spec/sync.md` already names `session/` as the lifecycle/cycle/live/SSE owner; `spec-gaps-check` passed through `just prepush`. | Pass |
| Root sync gate: focused crate | `cargo test -p futo-notes-sync`: 55/55 default tests; 25 server and 2 SSE cases explicitly ignored without an isolated server. | Pass |
| Root sync gate: cross-platform behavior | `just test-cross-platform`: 30/30, 0 failed, 0 skipped in the final prepush run. No new scenario was needed because protocol/product semantics did not change. | Pass |
| Root sync gate: isolated server contract | On owned port 3113/database/blob storage, server integration was Cargo 25/25 with 24 substantive cases and SSE was 2/2; the demo server was never used. | Pass |
| Root sync gate: CRITICAL push-first | Every trigger reaches `cycle::run`, which delegates to the canonical push-first cycle; F1/server and cross-platform guards pass. | Pass |
| Root pre-merge gate | `just prepush` passed `check`, full Rust workspace, 247 Playwright tests, and 30 cross-platform scenarios. | Pass |
| Sync spec: one Rust session owner | Only `SyncSession` stores connected state, the cycle gate, and the registered `LiveTask`; shells continue to call the frozen session API. | Pass |
| Sync spec: checkpoint progress survives final-save failure | Both `uploaded_state_survives_final_checkpoint_failure_in_the_running_session` and `downloaded_state_survives_final_checkpoint_failure_in_the_running_session` pass in `cycle.rs`. | Pass |
| Sync spec: live doorbell/safety/reconnect/callback policy | `connected_stream.rs` keeps immediate catch-up, event/push deadlines, safety poll, read timeout, and callback classification; SSE and cross-platform acceptance pass. | Pass |
| Sync spec: disconnect ancestry and storage quiescence | Existing reconnect/peer-delete scenarios pass; `stop_live_and_wait_observes_the_cycle_gate` passes. | Pass |
| Sync spec: E2EE/wire/persisted compatibility | No crypto, HTTP payload, state schema, cursor, or checkpoint format changed; isolated real-server and FFI contracts pass. | Pass |
| Organization/refactoring Structure: narrow owner and cohesive capability grouping | All new files live under `session/`; the `live/` folder groups task, runner, connected-stream, and framing responsibilities. | Pass |
| Organization/refactoring Structure: entry point is orchestration | `session/mod.rs` exposes the frozen contract and delegates connection, cycle, and live-task operations through named modules. | Pass |
| Organization/refactoring Structure: private/local code, import direction, deliberate facade | Child modules are private, use explicit inputs, and depend inward on sync/server/checkpoint owners; external consumers use the existing session facade. | Pass |
| Organization/refactoring Structure: shared code has independent consumers | No new global/shared abstraction exists; session-private capabilities remain local. | Pass |
| Organization/refactoring Structure: tests co-located with owners | Facade, cycle, and parser tests sit with the behavior they guard; assembled behavior remains in integration/E2E suites. | Pass |
| Organization/refactoring Structure: technical folders clarify without fragmentation | `live/` is one real multi-file capability; final files range from 24 to 179 production lines and no one-function warehouse/helper file exists. | Pass |
| Organization/refactoring Structure: API route delegation | No HTTP route/controller implementation is in the declared private Rust session scope. | N/A |
| Organization/refactoring Structure: cross-feature type placement | No cross-feature type was added or moved; public types retain their existing crate owners and private live types remain local. | Pass |
| Organization/refactoring Naming: semantic paths/exports and precise functions | Paths and names such as `cycle`, `connected_stream`, `connect_event_stream`, `run_cycle_and_notify`, and `schedule_remote_pull` state their roles. | Pass |
| Organization/refactoring Naming: claims/domain types/no vague names | Booleans read as claims, types name lifecycle/protocol roles, and final source contains no generic helper/manager/processor/data owner. | Pass |
| Organization/refactoring Naming: contractual abbreviations | Established `sync`, SSE, E2EE, and HTTP vocabulary and all shipped names remain unchanged. | Pass |
| Organization/refactoring Naming: UI component conventions | The declared scope contains no UI components. | N/A |
| Organization/refactoring Components/state: UI composition/effects rules | The declared scope contains no page/component/render state. | N/A |
| Organization/refactoring Components/state: smallest mutable owner | `SyncSession` alone owns durable mutable connection/lifecycle state; task-local channels, timers, parser buffer, and backoff do not create another owner. | Pass |
| Organization/refactoring Functions: pure/effect boundaries and readable narratives | SSE framing is pure/local; facade, runner, connected stream, and cycle functions each read at one abstraction level with explicit effects. | Pass |
| Organization/refactoring Functions: extract dense operations, keep simple branches inline | Connection, retry waiting, cycle notification, stream reads, and remote-pull scheduling are named; short result/error branches remain inline. | Pass |
| Organization/refactoring Functions: no symmetry/LOC-only helpers | Every extracted file/function owns a protocol phase or lifecycle responsibility; accounting is explicitly not an architectural target. | Pass |
| Organization/refactoring Functions: top-down async sequencing | Required work is awaited; cancellation remains selectable during connection, stream read, scheduling waits, safety poll, and backoff. | Pass |
| Organization/refactoring Functions: trust boundaries/errors/external shapes | Conforming `connect.rs` and server boundaries remain unchanged; stable error classification and application-owned state/summary shapes pass real-server and consumer tests. | Pass |
| Organization/refactoring Functions: instances justified by semantics | `SyncSession` and `LiveTask` exist for instance lifecycle/state; stateless behavior uses functions/plain data. | Pass |
| Organization/refactoring Comments/specs: correct information homes | Product requirements remain in `docs/spec/sync.md`; rewrite rationale/evidence lives here; the sole code comment records a local ordering obligation. | Pass |
| Organization/refactoring Comments/specs: no narration/dead code/stale references | Comment census and old-symbol/path searches are clean; deleted implementation is not commented out and the stale test narrative is gone. | Pass |
| Organization/refactoring Comments/specs: operational scripts | No operational script was modified. | N/A |
| Organization/refactoring Verification: tests/types/lint/format | Focused and full tests, TypeScript/Svelte checks, lint, repository format check, targeted Rust formatting, and `git diff --check` pass. | Pass |
| Organization/refactoring Verification: narrow placement and boundary-inward comprehension | Final responsibility/function tables show a reader can follow `session/mod.rs` → `cycle` or `live/` → runner/connected stream/parser. | Pass |
| Organization/refactoring Verification: dependencies/scaffolding/compatibility | No dependency was added; the old private live scaffold and old parser path are absent; supported public/wire/persisted surfaces are unchanged. | Pass |

## Final invariant-to-guard map

| Invariant | Final guard/evidence | Status |
| --- | --- | --- |
| S1 one application session API | FFI sync-contract 2/2, Tauri library 26 pass, cross-platform 30/30, empty public-surface diff | Pass |
| S2 sole mutable lifecycle owner | Final state-owner source audit plus `status_is_nonblocking_and_reports_lock_contention_as_unavailable` | Pass |
| S3 canonical push-first for every trigger | `f1_native_sync_is_push_first_no_silent_overwrite`; cross-platform `edit during sync keeps local draft`; cycle call-path audit | Pass |
| S4 mutual exclusion and migration quiescence | `stop_live_and_wait_observes_the_cycle_gate` | Pass |
| S5 checkpoint-failure memory progress | `uploaded_state_survives_final_checkpoint_failure_in_the_running_session`; `downloaded_state_survives_final_checkpoint_failure_in_the_running_session` | Pass |
| S6 safe authoritative connect/key convergence | `connect_bootstrap_and_shared_vault`; `concurrent_connect_converges_to_one_vault`; `missing_key_with_objects_does_not_mint` | Pass |
| S7 collection-gone terminal healing signal | `resume_after_vault_deleted_signals_collection_gone_then_reconnects`; `run_sync_after_vault_deleted_signals_collection_gone`; live terminal-path audit | Pass |
| S8 exact snapshot/nonblocking status | `status_is_nonblocking_and_reports_lock_contention_as_unavailable`; FFI lifecycle contract | Pass |
| S9 safe live start/replace/notify/stop | `stop_and_change_notifications_are_safe_without_a_live_task`; FFI disconnected lifecycle contract | Pass |
| S10 catch-up/doorbell/rich summary | SSE `auto_pull_on_peer_push`; FFI full-summary sync contract; `schedule_remote_pull` audit | Pass |
| S11 debounce/safety/idle/backoff liveness | SSE `reconnect_catches_missed_change`; cross-platform rapid reconnect/offline accumulation; constants/schedule audit | Pass |
| S12 stable stream/cycle error classification | Tauri library tests, collection-gone acceptance tests, runner/connected-stream error-path audit | Pass |
| S13 prompt idempotent cancellation | facade stop tests, SSE reconnect suite, select/cancellation source audit | Pass |
| S14 SSE framing compatibility | `parses_multiple_named_events`; `ignores_comment_heartbeats`; `handles_crlf_and_network_chunk_boundaries`; `multiline_data_dispatches_one_event` | Pass |
| S15 disconnect demotes to ancestry | isolated server reconnect scenarios and cross-platform `peer deletes while disconnected` | Pass |
| S16 client-side encryption/wire compatibility | isolated server 24 substantive cases, cross-platform 30/30, FFI contracts, empty semantic-surface diff | Pass |
| S17 background/nonblocking behavior | spawned async live-task source audit, full Playwright 247/247, cross-platform 30/30 | Pass |

## Verification log

- Baseline is complete and recorded above: 55 focused sync tests, 24 substantive isolated-server
  cases plus one explicitly unexecuted small-blob Core case, 2 SSE cases, 30 cross-platform cases,
  and 6 FFI consumer-contract cases passed.
- Gate A contract capture, ownership design, test reconciliation, and design-stage compliance
  evidence were approved without amendment.
- The complete target skeleton was created first and compiled before behavior moved. First green
  was reached in the target tree with no transitional warehouse.
- The first Gate B packet was rejected for readability. Its user-directed live-capability
  refinement is implemented, approved for merge, and green with an empty semantic-surface diff
  and complete comment census.
- Final `PATH=/Users/mason/.bun/bin:$PATH FUTO_NOTES_E2EE_SERVER_REPO=/Users/mason/futo-notes-server just prepush` exited 0:
  - spec gaps: 12 gaps and 9 closure probes passed;
  - generated toolbar, bridge, and Rust-owned TypeScript sync contract checks passed;
  - architecture gates passed (33 commands/0 dead, 11 allowlisted platform uses/0 unsanctioned,
    8 drift concepts, debt ratchet current);
  - Rust model conformance 6/6, lint, Svelte check (0 errors/warnings), and format check passed;
  - Vitest 827 passed/10 skipped; editor 341/341; TypeScript and Vite build passed;
  - full Rust workspace passed: core 102, FFI 6, model 28, search 8 with 1 ignored perf test,
    store 26, sync 55, and Tauri 26 with 1 ignored real-OS secret-store test;
  - Playwright 247/247 passed;
  - real desktop/server cross-platform sync 30/30 passed, 0 failed, 0 skipped.
- Final isolated dev-auth server verification used owned database
  `futo_notes_session_gate_c_c7cf_20260721`, owned blob directory
  `/tmp/futo-notes-session-gate-c-c7cf-20260721`, and port 3113:
  - `server_integration -- --ignored --test-threads=1`: Cargo 25/25, 24 substantive cases;
  - `sse_live -- --ignored --test-threads=1`: 2/2;
  - the server was stopped, the owned database dropped, and the owned blob directory removed.
- Targeted `rustfmt --edition 2021 --check` for every changed Rust file and `git diff --check`
  passed. The full-tree `cargo fmt --all -- --check` still reports unrelated pre-existing
  formatting in model/search/store and existing sync tests; no unrelated file was rewritten.
- Final public-surface extraction diff is empty. Final source/spec searches found no old
  live-center symbols, no `live_sync` module, and no stale `session/event_stream` reference; this
  ledger intentionally retains those names where it records base and rejected-stage history.

## Accounting and final structure

- Binding baseline: 607 production lines across three session files; 395 co-located test lines;
  3,618 external acceptance-test lines. `session/mod.rs` is the largest file at 428 production +
  351 test lines.
- Rejected first Gate B: 632 production lines across five session files.
- Final: 733 production lines across seven session production files; 443 co-located test lines;
  3,615 external acceptance-test lines after deleting three stale test-comment lines. Combined
  scope accounting is 607 → 733 production (+126, +20.8%) and 4,013 → 4,058 tests (+45, +1.1%).
- Files with production increased 3 → 7 and total inventoried source files increased 7 → 11.
  Largest final production files are `live/connected_stream.rs` 179, `connect.rs` 155,
  `mod.rs` 152, `live/runner.rs` 129, `live/mod.rs` 56, `cycle.rs` 38, and
  `live/event_stream.rs` 24.
- The production increase is intentional: it replaces a mixed 428-line center and the rejected
  262-line live warehouse with explicit protocol/lifecycle phases and named functions. No final
  production file exceeds 179 lines; the increase lowers local cognitive load rather than chasing
  a line-count reduction.
- The bundled helper was run with the recorded Gate A command and manually inspected because its
  explicit-current-path mode omits a deleted baseline path. The reproducible baseline archive and
  mixed-Rust split are the authoritative 607/4,013 figures; the same inspected classification gives
  the final 733/4,058 figures.
- Final module responsibilities are the seven-row current-tree table in the revised Gate B packet.
  `SyncSession` owns state/lifecycle; every other module owns one stateless or task-local phase.

## Bugs found and follow-ups

- Product bugs found in the old implementation during Gate A: none.
- Baseline setup failures were environmental (Bun PATH, server checkout path, auth mode,
  dependencies), not product behavior failures.
- The small-blob oversize Core scenario returned early because
  `FUTO_TEST_SMALL_BLOB_SERVER` was unavailable. It is a lower protocol-owner case, not a missing
  session contract, and is not claimed as substantively executed.
- No in-scope promise is deferred, and no semantic change is proposed.
- Final ledger totals: **9 Fast, 50 Acceptance, 7 Core, 0 Obsolete, 0 Follow-up**.
- Deleted private structures: the root live loop, `LiveContext`, `LiveInputs`, `CycleResult`,
  `StreamResult`, `cycle_stopped`, `sync_with_checkpoint`, the rejected `live_sync.rs` warehouse,
  and the old `session/event_stream.rs` path. Their product promises remain guarded in the final
  owners.
