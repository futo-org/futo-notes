# Sync transfer executor rewrite

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/sync-transfer-executor-rewrite.md
```

## Owners and dependency direction

| Responsibility | Owner | State/lifecycle | Dependencies |
| --- | --- | --- | --- |
| Complete push-first cycle and dirty-path handoff | `sync::transfer` facade | Owns one cycle's in-flight transfer state | push/pull policy, checkpoint, HTTP transport |
| Upload preparation, create-ID barrier, settlement | `transfer::upload_executor` | Mutates the cycle's `ConnectedState` | vault, encryption, conflict/tombstone collaborators |
| Download scheduling and bounded completions | `transfer::download_executor` | Ephemeral task queues only | HTTP transport, decryption |
| Retry, concurrency, batch/classic fallback | `transfer::http_transport` | Per-cycle capability/fallback flags | `server::Http`, protocol frames |
| Frozen binary framing and validation | lower-level `server::{batch_upload,batch_download}` | Stateless | byte slices and server wire records |
| Final write/remove/rename revision guard | existing `pull::apply_remote` collaborator | No second durable owner | vault state + transfer dirty paths |
| Blob attachment/orphan/delete/GC serialization | server `blob-object-persistence` | PostgreSQL transaction/advisory lock | object routes, collection routes, GC |

Dependencies point from cycle policy to the transfer facade, from the facade to focused executors,
and from executors to the concrete HTTP boundary. Provider response shapes do not escape
`http_transport`.


## Safety invariants

| Invariant | Source | Baseline/final guard |
| --- | --- | --- |
| Every trigger is push-first | sync spec | `f1_native_sync_is_push_first_no_silent_overwrite` |
| Dirty local bytes are never overwritten/deleted by pull | sync spec + approved fix | new failed-upload and edit-during-replay acceptance tests |
| Unrelated pull work may settle while a dirty target defers | approved design | new dirty-target cursor-cap test |
| Every create UUID is durably saved before any request | sync spec | `create_identity_is_checkpointed_before_a_classic_request` plus batch equivalent |
| Restart/retry reuses the same create UUID | sync spec | existing pending-create/replay restart matrix |
| Updates/deletes remain version guarded | server design | classic/batch conflict and ambiguous-commit tests |
| Partial successes update memory and attempt a checkpoint incrementally | sync spec | completed-chunk-before-slow-chunk tests |
| Post-commit checkpoint failure keeps learned in-memory state | sync spec | session checkpoint-failure tests |
| Failed/deferred download caps the pull cursor | sync spec | cursor-cap tests with failure, repair, and retry |
| Batch is only an optimization | sync spec | batch/classic semantic parity and fallback tests |
| Batch parser rejects malformed and illegal status/payload pairs | wire contract | protocol-frame tests |
| New client/old server and old client/new server remain compatible | sync spec | classic fallback and legacy response tests |
| Server never reads plaintext and remains user scoped/stateless | server instructions/design | unchanged opaque bytes; server isolation suites |
| Collection deletion cannot miss a concurrently attached blob | lifecycle contract | new lock-barrier test |
| Persistent blob-store failures cannot starve later GC rows | lifecycle contract | new 501+-row traversal test |


## Failures identified in the old implementation

1. A mapped upload failure is recorded as a nonfatal summary item, allowing the same cycle's pull
   to overwrite the still-dirty local path.
2. Replay hydration can overwrite an edit made while replay/successor work is in flight.
3. The batch download parser accepts illegal status/payload combinations.
4. Collection deletion snapshots blob references before the lifecycle lock.
5. Persistent failures in the first eligible GC page can starve later rows.
6. The then-current F-series convergence tests did not prove the batch endpoints were selected.
7. The sync spec still referenced the removed upload-module path.
