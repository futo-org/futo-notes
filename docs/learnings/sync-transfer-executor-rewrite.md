# Sync transfer executor rewrite

Status: Gate B ready; implementation and required verification are green.

## Workspace and scope

- Client worktree: `/Users/mason/.codex/worktrees/sync-transfer-executor/futo-notes`
- Client branch/base: `codex/rewrite-sync-transfer-executor` at
  `93a74b978f52720b6c55fb229fbb97097062e0e6`
- Server worktree: `/Users/mason/.codex/worktrees/sync-transfer-executor/futo-notes-server`
- Server branch/base: `codex/rewrite-batch-blob-lifecycle` at
  `f991b7daf767ad75b5e4718ed0cdbfc7ffb25ef7`
- Starting state: both worktrees intentionally contain the complete uncommitted batch-transfer
  baseline copied from the preceding implementation branches.
- Client scope: transfer preparation, durable create identity, batch/classic dispatch, semantic
  settlement, incremental checkpointing, dirty-path handoff, and final pull revision validation.
- Server scope: blob attachment, orphaning, collection deletion, and physical-GC lifecycle
  serialization.
- Explicitly excluded: public/FFI/Tauri APIs, checkpoint schema/version, HTTP routes or payloads,
  merge policy, collision policy, tombstone policy, encryption, authentication, deployment, and
  the production/demo server.

## Authorities read completely

- Client `AGENTS.md`, `docs/spec/AGENTS.md`, `docs/spec/sync.md`, `justfile`
- `docs/architecture/codebase-organization.md`
- `/Users/mason/Downloads/codebase-refactoring.md`
- Server `AGENTS.md`, `src/db/AGENTS.md`, `DESIGN.md`
- `guided-contract-rewrite/SKILL.md` and all five references
- `contract-rewrite/SKILL.md`, `references/ledger.md`, and `references/futo-notes.md`

The read lease remains valid while the approved ownership, module tree, and dependency direction
remain unchanged.

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

## Approved target tree

| Target path | Responsibility | Provenance | Expected risk |
| --- | --- | --- | --- |
| `sync/transfer/mod.rs` | Small facade and push-first transfer orchestration | Rewrite from contract | High: safety sequencing |
| `sync/transfer/upload_executor.rs` | Prepare/dispatch/settle/checkpoint upload workflow | Rewrite from contract | High: ambiguous commits |
| `sync/transfer/download_executor.rs` | Fetch/decrypt bounded download completions | Rewrite from contract | High: cursor/application order |
| `sync/transfer/http_transport.rs` | Batch/classic selection, retry, fallback, concurrency | Rewrite from contract | Medium: compatibility |
| `server/batch_upload.rs` | Exact upload frame sizing/encoding and strict result decoding | Reuse as lower-level protocol owner | Medium: frozen wire contract |
| `server/batch_download.rs` | Exact download frame decoding and status/payload validation | Focused rewrite in lower-level protocol owner | Medium: frozen wire contract |
| `sync/push/*` | Scan, rename/delete, conflict and tombstone policy collaborators | Reuse where conforming | Existing behavior frozen |
| `sync/pull/apply_remote.rs` | Collision/tombstone policy plus final local-revision validation | Focused rewrite | High: data safety |
| server `src/objects/blob-object-persistence.ts` | One blob lifecycle transaction owner | Existing owner, extend | High: deletion race |
| server `src/maintenance/blobGc.ts` | Deterministic starvation-safe traversal | Focused rewrite | Medium: maintenance liveness |

The final tree must not retain `sync/upload`, `sync/download`, split
`push/apply_upload`, or direct create HTTP paths as forwarding warehouses.

### Approved target-tree correction

Implementation exposed one dependency-direction error in the original Gate A packet:
`server::Http` is the lower-level protocol boundary already consumed by `sync`, so moving binary
framing into `sync::transfer::protocol_frames` would make `server` depend back on the higher-level
workflow. The corrected binding tree keeps encoding, strict decoding, and encoded-size calculation
in `server::{batch_upload,batch_download}`. `sync::transfer::http_transport` consumes the smallest
server-owned contracts and normalizes both batch and classic responses before they reach the
executors. The lifecycle owner, transfer facade, executors, state model, and dependency direction
approved at Gate A are otherwise unchanged. Parent guidance approved this local correction.

## Current responsibility inventory

| Current path/group | Responsibilities | Problem | Disposition |
| --- | --- | --- | --- |
| `sync/upload/` | upload packing, task scheduling, retry/fallback | exposes Batch/Classic above transport | Replace |
| `sync/download/` | download packing, scheduling, retry/fallback, progress | callback settlement and transport leak together | Replace |
| `push/apply_upload/` | maps upload transport outcomes into sync state | duplicated semantic center | Replace |
| `push/create_identity/` | durable IDs, restart recovery, direct create/replay HTTP | direct network paths bypass one executor | Split durable policy into executor; delete direct HTTP |
| `server/batch_upload*` | binary request/JSON response wire adapter | transport shape leaked into push settlement | Retain as lower-level owner; normalize in `http_transport` |
| `server/batch_download.rs` | binary response parser | missing status/payload product validation | Retain and strictly validate |
| `push/mod.rs` | complete push policy | mixes policy with transfer mechanisms | Retain policy; delegate transfers |
| `pull/mod.rs` | listing/cursor/application policy | no unconditional final revision gate | Retain policy; add guard |
| `pull/apply_remote.rs` | collision/ancestry/filesystem application | can act on a stale scheduled revision | Add compare-immediately-before-mutation |
| server collection deletion | snapshot, orphan ledger, cascade | snapshot currently precedes lifecycle lock | Lock before snapshot |
| server GC | eligible-page retry/delete loop | fixed first page can starve later rows | Deterministic keyset traversal |

## Semantic surface disposition

| Surface | Kind | Consumer | Disposition |
| --- | --- | --- | --- |
| `SyncSession::{connect,resume,sync,start_live,...}` | Product semantic | FFI/Tauri/native shells | Frozen |
| `run_sync`, `run_push`, `run_pull` crate-visible behavior | Product semantic/test boundary | integration tests/session | Preserve behavior and signatures unless internal visibility permits direct migration |
| `SyncSummary`, failures, conflicts, renamed IDs, local-write flag | Product semantic | every shell | Frozen field-for-field |
| `ConnectedState` and checkpoint v1 JSON names | Persisted product contract | existing installations | Frozen |
| create UUID / idempotency header and legacy server ID adoption | Wire/compatibility contract | old/new client/server combinations | Frozen |
| batch upload/download routes, framing, limits, status names | Wire contract | released clients/servers | Frozen |
| classic routes and 404/405/501 fallback | Wire compatibility contract | mixed versions | Frozen |
| `UploadDispatch`, `BatchMutation`, batch fallback atomics | Private mechanism | transport executor only | Confine below `http_transport` |
| split create replay/direct-create helpers | Private mechanism | old push internals | Delete after one executor owns them |
| generated native bindings | Generated artifact | native builds | No semantic input changes expected; do not edit |

No semantic deletion, signature reduction, persisted-field addition, wire change, or public API
change is approved or planned.

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

## Baseline accounting

The bundled `account_scope.py` counts physical source lines including blanks/comments, classifies
test paths by name, and treats Rust content after the first `#[cfg(test)]` as test code. Its
directory enumeration does not tolerate deleted tracked files, so the copied working-tree
inventory is supplied as the explicit `rg --files` list.

| Scope | Production | Tests | Source files |
| --- | ---: | ---: | ---: |
| Client broad sync/server/integration inventory | 4,422 | 6,975 | 46 |
| Client final broad inventory | 4,362 | 7,355 | 48 |
| Server objects/blobs/collections/maintenance/tests inventory | 1,648 | 2,417 | 22 |
| Server final broad inventory | 1,759 | 2,544 | 24 |

These broad counts include conforming collaborators outside the replacement center. Final
accounting uses the same bundled script and physical worktree inventory. The heuristic counts
`server/batch_upload/tests.rs` and `pull/tests.rs` as production because their filenames are
`tests.rs`; the totals are therefore reproducible structural metrics, not executable-code totals.

## Baseline verification

| Command | Result | Count/notes |
| --- | --- | --- |
| `cargo test -p futo-notes-sync` | Pass | 139 library tests; 30 live tests ignored without a server |
| `bun install --frozen-lockfile` | Pass | 25 packages installed; lockfile unchanged |
| `bun run test` | Pass | isolated PostgreSQL database; all 10 files passed |

## Test-promise ledger

Rows group tests only when they express one shared product promise. Exact final test names and
counts are reconciled before Gate B.

| Legacy test area / representative tests | Plain-English promise | Class | Final owner/guard |
| --- | --- | --- | --- |
| upload fallback/retry tests | unsupported or exhausted batch uploads use classic requests in the same cycle | Fast | `http_transport` fallback tests |
| encoded batch cap | actual encoded upload bodies never exceed 8 MiB/100 entries | Fast | transport packing plus server frame sizing |
| upload frozen-frame tests | upload frame bytes and integer bounds remain compatible | Fast | `server::batch_upload` |
| upload response status/ID validation matrix | response status must match operation and success object ID | Fast | `server::batch_upload` |
| classic create compatibility | classic sends stable client identity and accepts legacy response shape/ID | Fast | `http_transport` |
| batch create/replay/update/conflict matrix | batch outcomes have the same semantics as classic outcomes | Fast | normalized outcome parity table |
| batch 404 push-wide flag | unsupported endpoint is not repeatedly probed within one cycle | Fast | `http_transport` |
| create identity pre-dispatch tests | no create request leaves before the UUID checkpoint succeeds | Fast | `upload_executor` |
| pending-create restart tests | restart rebinds only an unambiguous same-content candidate and reuses UUID | Fast | `upload_executor` |
| create replay successor tests | newer local bytes become a guarded successor rather than falsely clean | Fast | `upload_executor` |
| tombstone recovery create tests | edit-wins recovery creates a live object with one durable identity | Fast | executor + existing tombstone collaborator |
| completed upload chunk checkpoint test | completed work settles/checkpoints before waiting for slower chunks | Fast | `upload_executor` |
| stale in-flight upload test | an edit made in flight remains dirty after the older response | Fast | `upload_executor` |
| failed mapped upload regression | a failed upload cannot be followed by overwriting that dirty target | Fast | new cycle-level regression |
| replay hydration regression | an edit made during replay/successor work cannot be hydrated over | Fast | new cycle-level regression |
| download fallback/retry/omission tests | malformed, unsupported, exhausted, and omitted batch entries retry/degrade correctly | Fast | `http_transport` |
| completed download checkpoint test | a completed batch applies/checkpoints before a slow single completes | Fast | `download_executor` |
| download progress test | each scheduled blob advances progress exactly once | Fast | `download_executor` |
| download frozen-frame parser | frame order/keys/lengths/statuses are validated | Fast | `server::batch_download` |
| illegal download status/payload regression | `ok` requires bytes and `missing`/`omitted` forbid bytes | Fast | new server parser matrix |
| pull skips current objects | relisting from a pinned/zero cursor does not redownload settled objects | Fast | pull policy integration |
| cursor cap unit/integration tests | cursor never passes a retryable failed/deferred change | Fast | pull completion test |
| apply/collision/ancestry tests | existing collision, healing, ancestry, timestamp, and tombstone behavior is unchanged | Core | existing pull/policy tests |
| vault scan/symlink tests | incomplete or unsafe scans cannot cause remote mutations or vault escape | Core | existing vault tests |
| checkpoint/session failure tests | learned state survives final checkpoint and later cycle failures | Acceptance | existing session tests |
| F-series single/update/conflict/delete/move | assembled client/server semantics converge | Acceptance | isolated `server_integration` scenarios |
| F-series batch first push/download | real integration converges through the batch-capable server | Acceptance | F-series scenarios plus exact-route transport tests |
| F-series legacy fallback | new client falls back to classic while preserving create identity | Acceptance | isolated integration scenario |
| cross-platform sync scenarios | desktop/native consumers preserve push-first and file outcomes | Acceptance | `just test-cross-platform` named scenarios |
| server batch upload route suite | framing, ordering, per-entry isolation, idempotency, tenant scope, limits, notification | Fast | retained server route tests |
| server batch download route suite | auth, ordering, missing/foreign handling, limits, omission | Fast | retained server route tests |
| server orphan retention/reattach tests | attachment/orphan transitions serialize and restart retention | Fast | blob lifecycle tests |
| collection delete lifecycle regression | deletion snapshots only after acquiring lifecycle lock | Fast | new server barrier test |
| GC attachment race | GC cannot delete a blob that became live | Fast | existing barrier test |
| GC starvation regression | failed first page cannot prevent later eligible deletion attempts | Fast | new 501+-row test |
| server isolation suite | every object/blob query remains user scoped | Acceptance | existing server isolation tests |

Final disposition totals: Fast 27 grouped promises, Acceptance 6 grouped promises, Core 3 grouped
promises, Obsolete 0 product promises, Follow-up 0. The private execution modules were deleted
after their behavioral promises were moved to the named new-owner tests.

## Comment policy

Retain comments only for non-obvious durability ordering, ambiguous-commit recovery, retry timing,
wire layout, and filesystem race constraints. Move product promises to `docs/spec/sync.md`, move
rewrite history here, and delete comments that narrate the code or old module paths. The final
added-comment census found no new narrative comments in the transfer executor or lifecycle/GC
fixes; retained server comments describe version-guard and paging contracts from the incoming
batch-transfer baseline.

## Requirement-to-evidence matrix

| Requirement | Planned evidence | Status |
| --- | --- | --- |
| Narrowest real owner and cohesive module folder | approved target tree plus final path audit | Complete |
| Entry points read as orchestration | `transfer/mod.rs` responsibility/LOC review | Complete |
| One mutable lifecycle owner; no second journal | unchanged checkpoint fields plus state-owner audit | Complete |
| Provider shapes normalized at boundary | batch/classic dispatch absent above `http_transport` search | Complete |
| Precise names and explicit dependencies | final substantial-file and import audit | Complete |
| Co-located behavior tests; no test warehouse | final test-location map | Complete |
| Product behavior in spec; only non-obvious source comments | spec diff plus complete comment census | Complete |
| Complete moves and no stale paths | repository-wide old-path searches | Complete |
| Public/product semantics frozen | before/after semantic-surface diff | Complete |
| Persisted and wire contracts frozen | checkpoint/frame/compatibility tests | Complete |
| Every legacy promise disposed with named guard | reconciled ledger totals | Complete |
| Nonzero focused and acceptance coverage | 139 fast, 28 server integration, 2 live, 2 desktop scenarios | Complete |
| Every client/server consumer verified | verification command matrix | Complete |
| Separate reproducible production/test accounting | bundled script baseline/final plus manual inspection | Complete |
| Push-first and dirty-local safety | cycle regressions and isolated integration | Complete |
| Stable create identity before dispatch and across restart | executor fault matrix | Complete |
| Incremental partial settlement and checkpoint behavior | bounded-completion fault tests | Complete |
| Failed/deferred pull cursor cap | pull failure/repair test | Complete |
| Mixed-version compatibility | fallback and legacy-ID tests | Complete |
| Server user scope, opacity, and statelessness | unchanged contracts plus server tests/typecheck/build | Complete |

## Known old-code findings to reproduce before replacement

1. A mapped upload failure is recorded as a nonfatal summary item, allowing the same cycle's pull
   to overwrite the still-dirty local path.
2. Replay hydration can overwrite an edit made while replay/successor work is in flight.
3. The batch download parser accepts illegal status/payload combinations.
4. Collection deletion snapshots blob references before the lifecycle lock.
5. Persistent failures in the first eligible GC page can starve later rows.
6. Current F-series convergence tests do not prove the batch endpoints were selected.
7. The sync spec references the removed `sync/upload.rs` path.

## Stage log

- Stage 0: complete authority read, approved ownership confirmed, worktrees/bases/status captured,
  bundled accounting run.
- Stage 1: baseline verification and regression capture complete.
- Stage 2: the structurally replaced client transfer executor is green at 139/139 library tests,
  including the failed-upload/pull-overwrite and replay-hydration revision guards. The server
  typecheck and isolated-database route suite are green at 11/11 after the collection-delete/GC
  fixes. Frozen frame encoding and response parsing remain in the lower-level `server/` adapter;
  `sync/transfer/http_transport/` is the only transfer HTTP caller and normalizes batch/classic
  completion before executor settlement.
- Stage 3: all 28 isolated real-server integration tests and both live-sync tests pass. The desktop
  harness passes `offline accumulation` (10 creates per peer, 20-note convergence) and `large
  sync` (1,000 realistic notes uploaded and downloaded with byte-exact spot checks).
- Stage 4: `just build`, `just test-rust-full`, server builds, server typecheck, sync-scoped
  formatting, strict sync clippy, diff checks, old-path searches, direct-HTTP searches, comment
  census, and final accounting pass. `cargo fmt --all --check` still reports pre-existing
  formatting differences outside the sync scope; those unrelated files were not rewritten. All
  temporary databases were dropped; blob fixtures and the temporary `psql` shim were moved to
  Trash.

## Final verification

| Command or scenario | Result |
| --- | --- |
| `cargo test -p futo-notes-sync --lib` | 139 passed |
| `cargo clippy -p futo-notes-sync --all-targets -- -D warnings` | Pass |
| sync-scoped `rustfmt --check` | Pass |
| `just test-rust-full` | Pass: core 109, FFI 7, model 28, search 8, store 67, sync 139, Tauri 28; 2 environment-specific tests ignored |
| `just build` | Pass |
| isolated `server_integration` on `127.0.0.1:3055` | 28 passed |
| isolated `sse_live` on `127.0.0.1:3055` | 2 passed |
| cross-platform `offline accumulation` | Pass: 20-note convergence |
| cross-platform `large sync` | Pass: 1,000 notes with byte-exact spot checks |
| server `bun run test` with isolated PostgreSQL | 65 passed across 10 files |
| server `bunx tsc --noEmit` | Pass |
| server `bun run build` and `bun run build:hosted` | Pass |
| client/server `git diff --check` | Pass |

The default Rust workspace command intentionally lists the 28 server-integration and 2 SSE tests
as ignored because they require a running isolated server; the same tests were run explicitly
against port 3055 above.
