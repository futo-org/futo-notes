# Sync Session Guided Contract Rewrite

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/sync-session-rewrite.md
```

## Frozen behavioral and protocol contract

Product semantics are frozen by default. No exported action, signature, field, error, callback,
result, protocol identifier, persisted format, wire/encryption behavior, timing guarantee, or
lifecycle behavior is proposed for deletion or change.

### Named invariants

| ID | Frozen invariant | Source | Baseline guard | Planned final guard |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S1 | `SyncSession` remains the one application session API used by FFI and Tauri; shells do not assemble their own sync lifecycle. | `sync.md`, root ownership rules | FFI sync contract; cross-platform 30/30 | Same consumer tests + semantic-surface diff |
| S2 | `SyncSession` is the sole owner of connected state, the cycle mutex, and live-task registration/start-stop. No ambient or second owner is introduced. | `sync.md`, both organization standards | Source inventory; disconnected FFI lifecycle | Target-tree audit + state-owner review |
| S3 | Every manual, initial-live, SSE, safety-poll, and local-change cycle executes the canonical full push-first workflow. | CRITICAL M3/M5 sync rules; `sync.md` | `f1_native_sync_is_push_first_no_silent_overwrite`; `edit during sync keeps local draft` | Same named scenarios + cycle call-path search |
| S4 | Cycles are mutually exclusive. A caller can stop live work and wait until any cycle holding the vault finishes before storage migration. | `sync.md`, app storage safety | `stop_live_and_wait_observes_the_cycle_gate` | Rewritten Fast test + Android consumer compile |
| S5 | A successful upload/download remains installed in running-session memory even if the final local checkpoint save fails; one checkpoint failure is reported and retry does not duplicate remote work. | `sync.md` final-checkpoint rule | `uploaded_state_survives...`; `downloaded_state_survives...` | Same promises co-located with `cycle.rs` |
| S6 | Connect authenticates, converges on the account's authoritative collection/key, refuses to mint a key for a nonempty keyless collection, and persists initial state before reporting success. | `sync.md` | `connect_bootstrap_and_shared_vault`; `concurrent_connect...`; `missing_key_with_objects...` | Unchanged acceptance scenarios |
| S7 | Missing/deleted collections map to `CollectionGone`; a live cycle treats it as terminal so consumers can repoint instead of retrying forever. | `sync.md` | two collection-gone server scenarios | Same scenarios + live error-path source audit |
| S8 | Snapshot is an awaited exact clone; `status()` never blocks and reports unavailable while the state lock is contended. | shipped Rust/FFI behavior | `status_is_nonblocking...`; FFI lifecycle contract | Same Fast/consumer tests |
| S9 | `start_live` requires a connected state, replaces any prior live task, and starts background work; `note_changed` and repeated `stop_live` calls are safe no-ops without a live task. | shipped API; `sync.md` | `stop_and_change_notifications...`; disconnected FFI lifecycle | Same Fast/consumer tests |
| S10 | A connected live stream performs an immediate catch-up cycle, treats `ready`/`change` only as debounced doorbells, and forwards the complete `SyncSummary`. | `sync.md` live section | `auto_pull_on_peer_push`; FFI full-shape contract | Same acceptance/consumer tests |
| S11 | Live liveness policy remains: 300 ms event debounce, 1 s local-push debounce, about 45 s safety poll, 90 s read-idle reconnect, and exponential reconnect backoff from 1 s capped at 30 s. | `sync.md`; shipped scheduling behavior | SSE reconnect scenario; cross-platform rapid reconnect/offline accumulation | Same acceptance scenarios + constants/scheduler audit |
| S12 | Stream read/EOF/idle and transient connect/client errors notify `on_error` then reconnect; HTTP 401 and `CollectionGone` terminate; cycle failures on a healthy stream call `on_cycle_error` without falsely reporting the stream down. | `sync.md`, desktop event contract | Tauri listener shape; `reconnect_catches_missed_change`; collection-gone tests | Tauri tests/compile + error-path audit |
| S13 | Cancellation can interrupt connection, stream reading, debounce timers, safety waits, and backoff. `stop_live` remains prompt and idempotent; `stop_live_and_wait` adds cycle-gate quiescence. | shipped lifecycle; storage migration spec | stop Fast tests; rapid reconnect; FFI lifecycle | Same guards + source-level select/cancellation audit |
| S14 | SSE framing accepts arbitrary network chunks and CRLF, emits one named event per frame, ignores comment heartbeats, and does not treat multiline data as multiple events. | server wire behavior | four `event_stream` Fast tests | Same unchanged tests |
| S15 | Disconnect stops live work, clears live connection state, and demotes verified state to ancestry rather than deleting reconciliation knowledge. | `sync.md` disconnect invariant | three reconnect server tests; peer-deletes-while-disconnected | Same acceptance scenarios |
| S16 | Encryption/key work stays client-side; key wrapping/unwrapping stays off async workers; server/wire/persisted formats remain byte/field compatible. | CRITICAL sync/data rules; `sync.md` | real-server suites; FFI semantic-shape contract | Semantic diff + full sync/consumer verification |
| S17 | Session work remains background/nonblocking relative to editor typing; no synchronous per-keystroke network, crypto, filesystem, or lock wait is added. | CRITICAL M5; `sync.md` | architecture/source inspection; live cross-platform runs | Dependency/state audit + full consumer verification |


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
