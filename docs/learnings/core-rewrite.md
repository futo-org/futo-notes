# FUTO Notes core contract rewrite

## Status

- Workflow: guided contract rewrite, dependency phase 1 (core).
- Current stage: Stage 5 compliance and verification complete for available toolchains.
- Review gate: **Gate C approved and committed; Android verification is environment-blocked as disclosed below.**
- Base commit: `885231efaac35ad5b7aee0f02dcbea693931aecc` (current `origin/main` when initialized).
- Implementation worktree: `/Users/mason/.codex/worktrees/c43d/futo-notes` (the fresh worktree used for the rewrite).
- Current branch: `refactor/core-crate` (created as `codex/rewrite-core`, then renamed after review).
- Initial state: clean detached worktree at the base commit; the branch was then created without copying any prior refactor branch.

## Exact scope

The declared scope is all of `crates/futo-notes-core` plus only the consumer files, fixtures,
documentation, and generated build inputs needed to establish, migrate, or verify its supported
contract. `LocalNoteStore` remains the durable note-workflow owner and `SyncSession` remains the
sync lifecycle owner. This phase does not rewrite either owner.

## Authorities read completely

The modifying agent read every required authority through EOF before planning or editing:
the guided and base contract-rewrite skills and all named references; repository `README.md`,
`justfile`, root and nested `AGENTS.md` files; applicable specs under `docs/spec/`; the complete
`docs/architecture/codebase-organization.md`; the complete
`/Users/mason/Downloads/codebase-refactoring.md`. The existing sync/local-note rewrite learnings
were also consulted. After context compaction, the complete organization standard was reread
through EOF before work resumed. `docs/spec/settings-visual.md` was also read to close the
previously unchecked surface-spec inventory.

## Narrowest owner

`futo-notes-core` is a portable stateless capability provider. It owns:

- hostile filename/path validation and incoming-path triage shared by the store and sync;
- recoverable atomic file primitives, timestamps, and exact binary blob transport;
- SHA-256 compatibility;
- E2EE cipher, frame, and vault-key formats;
- canonical image classification;
- three-way text merge; and
- cross-platform filename identity plus deterministic conflict names.

It owns no long-lived mutable lifecycle. `LocalNoteStore` owns vault workflows/search lifecycle and
`SyncSession` owns sync connection/checkpoint/live-task state. Core receives explicit paths,
bytes, keys, and plain data and returns ordinary results.

## Baseline accounting

Command:

`python3 /Users/mason/.codex/skills/guided-contract-rewrite/scripts/account_scope.py crates/futo-notes-core`

The script counts source lines including blanks/comments, detects path-named tests, and splits Rust
inline tests at the first `#[cfg(test)]`. The classifications were manually checked.

| Metric | Baseline |
| --- | ---: |
| Production lines | 1,672 |
| Test lines | 2,957 |
| Source files counted | 11 |
| Files with production | 8 |
| Files with tests | 10 |
| Legacy tests | 195 (192 pass by default, 3 ignored benchmarks) |

| Current file | Production | Test | Current responsibility |
| --- | ---: | ---: | --- |
| `src/files.rs` | 716 | 319 | Title/path rules, incoming triage, timestamps, atomic/no-replace writes, parked-backup recovery, blobs, rename, IDs |
| `src/sync.rs` | 362 | 669 | Filename identity/conflict names plus unused legacy DTOs, direction logic, rename inference, and collision suffixing |
| `src/e2ee.rs` | 285 | 266 | Cipher/KDF, note frames, key material/wrapping, plus unrelated merge/conflict re-exports |
| `src/invariants.rs` | 210 | 615 | Uncalled database-shaped NoteRecord audit API |
| `src/image.rs` | 41 | 45 | Canonical image/syncable filename classification |
| `src/merge.rs` | 27 | 160 | Three-way text merge |
| `src/hash.rs` | 24 | 200 | SHA-256 text/raw-byte hashing |
| `src/lib.rs` | 7 | 0 | Crate module declarations |
| `tests/adversarial.rs` | 0 | 495 | Mixed public contracts plus dead invariant/sync seams |
| `tests/path_safety_conformance.rs` | 0 | 29 | Shared TS/Rust path-safety fixture |
| `tests/sync_cycle.rs` | 0 | 159 | Synthetic cycle assembled from dead invariant/sync APIs |

## Baseline verification

| Command | Result |
| --- | --- |
| `cargo test -p futo-notes-core` | **Pass:** 192 passed, 3 ignored; default command executed nonzero tests |
| `cargo test -p futo-notes-model` | **Pass:** 28 passed |
| `cargo test -p futo-notes-store` | **Pass:** 26 passed |
| `cargo test -p futo-notes-sync` | **Pass:** 46 passed; 27 isolated-server tests intentionally ignored by default |
| `cargo test -p futo-notes-ffi` | **Pass:** 1 passed |
| `just test-rust-full` | **Pass:** 327 passed, 32 ignored across the workspace |
| `pnpm exec tsx tests/conformance/generate.mjs --check` | **Pass:** fixtures current |
| `pnpm run test:editor:minimal` | **Pass:** 243 passed |
| `pnpm exec tsc --noEmit` | **Pass** |
| `just test-cross-platform` with isolated local server | **Non-green baseline:** 28/30 passed; `active note reload` and `file moved to two folders by A and B` timed out in the cumulative run |
| Same two scenarios run individually | **Pass:** 1/1 and 1/1; supported behavior is executable, but cumulative harness stability remains an explicit baseline issue |
| Vite/Tauri build performed by the harness | **Pass:** 4,060 frontend modules transformed; desktop debug binary built |

The first harness attempt stopped before scenarios because `bun` was absent. A temporary
`pnpm dlx bun` binary was put on PATH without modifying the server repository or installing a
system-wide tool. No product result is inferred from that prerequisite failure.

## Public contract

| Surface | Consumers | Shipped externally? | Required behavior | Final owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| `files::{sanitize_title,validate_title,is_valid_title,...}` | model, native rule projections, sync ingress | Cross-language behavior is shipped | Filename is title; exact sanitization/validation and constants remain conformance-locked | `files::filenames` through `files` facade | Preserve semantics; migrate source location and drift registry |
| Safe note/app-data paths and incoming triage | store, sync, Tauri, TS conformance twin | Data-safety contract | No escape; exact depth/name-byte rules; accept/sanitize/ignore/reject are deterministic | `files::paths` | Preserve |
| Atomic replace/create, temp rename, parked-backup recovery | store, sync checkpoint, Tauri settings | Data-durability contract | Complete-at-visibility, no clobber, recover or preserve old bytes, no stale resurrection | `files::atomic_write` + `files::parked_backup` | Preserve |
| Timestamps and base64 blob I/O | store, sync, Tauri | Persisted/wire-adjacent behavior | Millisecond timestamps and exact raw bytes | `files::timestamps` + `files::blob_file` | Preserve |
| `hash_sha256*` | sync | Wire compatibility | SHA-256 over exact bytes, lowercase hex, no normalization | `hash` | Preserve |
| E2EE AES/PBKDF2/frame/key material | sync server/client path | **Shipped wire contract** | AES-GCM layout, PBKDF2 parameters, V2 emit/V1 decode, JSON/hex shapes and errors | `e2ee/*` through `e2ee` facade | Preserve byte-for-byte |
| Image extension set/classifier | model, sync, Tauri, FFI | Cross-shell behavior | Exact canonical 10-set; legacy formats remain ignored | `image` | Preserve |
| Three-way merge | sync conflict resolution | Shipped behavior | Clean non-overlap/identical/one-sided edits; overlapping edits conflict | `merge` | Preserve; sync imports it directly |
| Filename collision identity | store, sync, atomic files | Cross-platform data safety | Case + NFC/NFD equivalents collide without losing byte-distinct names | `files::filenames` | Move from dead `sync` warehouse |
| Conflict-copy names | sync conflict/tombstone/vault operations | Shipped filenames | Flat, bounded, deterministic, extension-preserving, user titles not mangled | `conflict_names` | Move from `sync` warehouse |
| `invariants::{NoteRecord,InvariantViolation,...}` | No production consumer | No | Database-shaped diagnostic mechanism only | None | Delete after ledger mapping |
| Legacy `sync` DTOs/direction/convergence/rename/suffix API | No production consumer | No; superseded internally | Pre-SyncSession mechanism only | None | Delete |
| `get_unique_note_id` | No code consumer; stale docs/comments only | Behavior remains through store | Collision choice belongs to the durable workflow that performs the create/rename | `futo-notes-store::paths` | Delete core API; update spec/drift/comments |
| `mtime_or_now`, V1 encoder, fixed-IV encryptor, public random/KDF helpers | No production consumer | No, except behavior used internally | Narrow visibility or delete; retain supported decoder/cipher behavior | Owning private module | Remove public scaffolding |

No Tauri command, FFI record/error, callback, event, configuration key, persisted state shape, or
UniFFI semantic signature is changed by the proposed rewrite.

## Safety invariants and guarding evidence

| Invariant | Source | Baseline guard | Planned final guard |
| --- | --- | --- | --- |
| SHA-256 hashes exact bytes to lowercase hex without line-ending/BOM normalization | sync spec; CRITICAL compatibility | `hash::known_vector`, `mixed_line_endings`, binary tests, real sync round-trip | Same focused `hash` tests + `editor roundtrip through real sync` |
| Ciphertext is `12-byte IV + ciphertext + 16-byte tag` and authentication rejects tamper/wrong key/truncation | sync spec/E2EE comments | AES-GCM round-trip/rejection tests; real-server scenarios | `e2ee::cipher` tests + `image sync roundtrip`/`editor roundtrip` |
| PBKDF2-HMAC-SHA256, 100k default iterations, 32-byte key, lowercase-hex KeyMaterial remain compatible | sync spec/server contract | RFC vector, wrap/unwrap, KeyMaterial JSON tests | `e2ee::password_key` and `vault_key` tests |
| Production emits V2 frames and decodes literal V1 frames | shipped wire compatibility | V1/V2 layout and round-trip tests | `e2ee::note_frame` literal byte vectors; delete V1 writer |
| User-controlled paths cannot escape roots, exceed depth/name limits, or use forbidden components | CRITICAL path safety | core path tests + shared fixture + store destructive-operation tests | retained conformance fixture + `files::paths` tests + store acceptance |
| Incoming sync paths receive exactly one deterministic accept/sanitize/ignore/reject decision | sync spec | core classifier test + `incoming names...` sync behavior test | `files::paths` test + same sync behavior test |
| Filename is title; sanitization does not transform case/dashes/words | M2/M6/M7; list/app specs | core title test + model/editor conformance | `files::filenames` + unchanged TS/Rust conformance |
| Atomic writes never expose partial bytes or discard the previous recoverable value | CRITICAL durability | core atomic tests + store create/recovery tests | `files::atomic_write`/`parked_backup` + store acceptance |
| Case/Unicode collisions never overwrite a distinct note | app/sync specs | collision-key tests, store collision tests, real sync scenarios | `files::filenames` + store tests + real-server collision scenarios |
| Recovery does not follow directory symlinks, clobber a newcomer, strand divergent bytes, or later resurrect stale content | durability comments + prior rewrite learning | five core recovery tests + store recovered-backup tests | `files::parked_backup` + store acceptance |
| Blob transport preserves every raw byte and never text-decodes images | sync spec | binary base64/hash tests + image sync round-trip | `files::blob_file` + `image sync roundtrip` |
| Image classification is exactly the canonical 10-set | M6/M7; sync spec | core/model/editor/FFI conformance tests | unchanged fixture plus `image` and FFI tests |
| Conflict names stay flat/idempotent/deterministic and preserve extensions/user titles | sync spec and July 2026 incident | 13 conflict-name tests + sync behavior tests | `conflict_names` tests + real-server conflict scenarios |
| Non-overlapping text edits merge; overlapping edits conflict; blobs are never text-merged | sync spec | 12 merge tests + `three way merge`/`concurrent edit conflict` | `merge` tests + same real-server scenarios |
| Millisecond mtimes remain round-trippable and server-authoritative | sync/list specs | core mtime test + sync server tests | `files::timestamps` + sync integration |
| Core remains portable and stateless and does not acquire search/model/shell dependencies | root/core AGENTS | Cargo dependency direction and dep guard | Cargo audit + `test:rust:dep-guard`/`just check` |

## Responsibility inventory and disposition

| Current path/surface | Responsibility | Public/private | State/effects | Problem | Disposition |
| --- | --- | --- | --- | --- | --- |
| `crates/futo-notes-core/Cargo.toml` | Core dependencies | Build surface | None | `rayon` and `rand_chacha` unused; `serde_json`/`proptest` test-only after dead sync removal | Remove unused; move JSON to dev dependencies |
| `src/lib.rs` | Crate entry | Public facade | None | Bare declarations are acceptable but target modules change | Keep as deliberate facade only |
| `src/files.rs` | Eight independent file/name capabilities | Public | Filesystem + process-local temp counter | 716-line warehouse; internal dependency on dead `sync` | Replace with focused `files/` capability folder |
| `src/e2ee.rs` | Cipher, KDF, frame, key material, unrelated re-exports | Public | CSPRNG only; no lifecycle | Several independently changeable contracts in one file | Replace with `e2ee/` facade and focused modules |
| `src/sync.rs` | Two live naming capabilities plus dead protocol architecture | Public | None | Majority has no caller; name falsely implies current sync owner | Extract supported capabilities, delete file |
| `src/invariants.rs` | Dormant NoteRecord audit API | Public | Reads filesystem | No caller; models a deleted database architecture and duplicates live-owner policy | Delete |
| `src/hash.rs` | SHA-256 | Public | None | Cohesive; test section inflated by ignored ad-hoc benchmarks | Keep, rebuild focused tests |
| `src/image.rs` | Canonical extension classification | Public | None | Cohesive; historical narration can move to learning | Keep |
| `src/merge.rs` | Three-way merge | Public | None | Cohesive | Keep |
| `tests/adversarial.rs` | Mixed supported and dead seams | Public crate integration | Filesystem | Mirrors old module topology and duplicates owner-local coverage | Translate; retain only coherent public-contract cases |
| `tests/path_safety_conformance.rs` | Cross-language fixture | Public crate integration | None | Correct ownership | Retain |
| `tests/sync_cycle.rs` | Synthetic cycle over dead APIs | Public crate integration | Filesystem | Tests an architecture no production path uses | Delete |
| Model consumers (`lib.rs`, `filename.rs`, `note.rs`, `image.rs`) | Note-rule facade | Internal workspace | None | Supported imports should continue through deliberate `files`/`image` facades | Verify; update only moved references |
| Store consumers (`lib.rs`, `paths.rs`, `vault.rs`) | Durable workflows | Internal workspace | **Lifecycle owner** | Imports filename identity from misleading `core::sync` | Migrate to `core::files` facade; keep lifecycle unchanged |
| Sync consumers (`server.rs`, `session/connect.rs`, `sync/*.rs`, `checkpoint.rs`) | Current protocol/orchestration | Internal workspace with shipped wire behavior | **Lifecycle owner is SyncSession** | Imports merge/conflict names through unrelated E2EE re-exports | Import `merge` and `conflict_names` directly; otherwise preserve |
| Tauri consumers (`filesystem_watcher.rs`, `image_commands.rs`, `system_trash.rs`, `vault_location.rs`) | OS projections | Internal workspace | Shell effects | Supported file/image APIs | Keep paths through facade and compile/test |
| `futo-notes-ffi` dependency/test | Native projection | Shipped semantic API | FFI boundary | No direct core API beyond canonical rule projection | Preserve FFI signatures; rebuild native artifacts during final verification |
| `scripts/drift-registry.json` + conformance fixtures | Cross-language locks | CI contract | None | Locations point at monolithic `files.rs` and stale unique-ID owner | Update locations/owner; never weaken locks |
| Specs/AGENTS/readmes/native comments | Behavioral and contributor references | Documentation | None | Several paths describe dead `sync`/`invariants`/unique-ID ownership | Update every moved authority/reference |
| Generated Swift/Kotlin bindings and native libraries | Generated artifacts | Build output | None | Internal Rust binary changes only; semantic UniFFI API unchanged | Regenerate via prescribed scripts, never hand-edit, verify no semantic binding drift |

## State/lifecycle map

| Responsibility | Mutable/in-flight state | Lifecycle | Stateless operation | Owner |
| --- | --- | --- | --- | --- |
| Vault root, serialized note mutations, watcher pre-write hook, search index | Yes | Bootstrap through shutdown | No | `LocalNoteStore` (unchanged) |
| Connection/checkpoint/cycle mutex/live task | Yes | Connect/resume/sync/live/disconnect | No | `SyncSession` (unchanged) |
| Hidden temp-name allocation | One process-local atomic sequence | None; uniqueness aid only | Allocation from explicit parent/purpose | `files::parked_backup` private implementation |
| All other core responsibilities | No | None | Yes | Focused core capability modules |

No extracted module may introduce ambient configuration, caches, locks, tasks, subscriptions, or a
second lifecycle owner.

## Proposed target tree

```text
crates/futo-notes-core/
  Cargo.toml
  src/
    lib.rs                         # public module facade only
    conflict_names.rs              # deterministic date/object conflict-copy filenames
    hash.rs                        # exact-byte SHA-256
    image.rs                       # canonical image/syncable classification
    merge.rs                       # three-way text merge
    e2ee/
      mod.rs                       # intentional E2EE public facade
      cipher.rs                    # CSPRNG IV/key material and AES-256-GCM
      password_key.rs              # PBKDF2-HMAC-SHA256 derivation
      note_frame.rs                # V2 encoder and V2/V1 decoder
      vault_key.rs                 # KeyMaterial JSON and wrap/unwrap workflow
    files/
      mod.rs                       # intentional durable-file public facade
      filenames.rs                 # title rules and case/Unicode filename identity
      paths.rs                     # note/app-data safety, note-ID parsing, incoming triage
      timestamps.rs                # now/file mtime conversion
      atomic_write.rs              # replace/no-replace writes and temp-hop rename
      parked_backup.rs             # collision parking protocol and bootstrap recovery
      blob_file.rs                 # exact binary base64 read/write
  tests/
    public_contract.rs             # only coherent cross-capability public promises
    path_safety_conformance.rs     # shared TS/Rust fixture
```

`files/mod.rs` and `e2ee/mod.rs` are deliberate public facades, not compatibility warehouses.
They declare private implementation modules and re-export only supported semantics. Internal
consumers import their actual owner (`merge`, `conflict_names`) rather than unrelated barrels.

## Expected deletions and migrations

- Delete `src/invariants.rs` and all 39 tests: no caller and its database-shaped state model was
  replaced by the store/sync owners.
- Delete `src/sync.rs` after moving its 20 supported filename/conflict-name promises; delete the
  other 39 tests and all dead DTO/direction/rename/suffix APIs.
- Delete the E2EE merge/conflict re-exports, the unused V1 encoder, and test-only public crypto
  helpers; migrate sync to direct owners.
- Delete core unique-ID selection and stale references; the store already owns the atomic workflow.
- Delete `tests/sync_cycle.rs` and the dead-seam portions of `adversarial.rs` after every row below
  has its replacement/disposition.
- Migrate store imports from `core::sync::{collision_key,collides_but_differs}` to `core::files`.
- Migrate sync imports from `core::e2ee::{MergeResult,conflict_*}` to `core::merge` and
  `core::conflict_names`.
- Update `scripts/drift-registry.json`, specs, root/core AGENTS module maps, prior learning
  references where authoritative paths moved, and native comments naming the unique-ID owner.
- Remove unused `rayon`, `rand_chacha`, and `proptest`; move `serde_json` to dev dependencies if
  still needed only by tests.

## Comment disposition

| Comment group | Keep | Move | Delete | Reason |
| --- | --- | --- | --- | --- |
| Wire byte layouts, KDF/AES parameters, V1 detection rule | Yes | Duplicate product wording to `docs/spec/sync.md` | Syntax narration | Shipped compatibility and non-obvious decoder constraint |
| Atomic no-replace, sidecar-before-park, restore ordering, symlink avoidance | Yes, concise and local | Incident chronology/codes to this learning | Repeated line-by-line narration | Data-safety ordering is load-bearing |
| July 2026 conflict-name blow-up rationale | Concise invariant | Full historical account here | Repeated examples after tests make behavior clear | History belongs in learning; idempotence stays visible |
| Image D4 history | Current compatibility statement | Historical migration detail here | Old diary text | Canonical set remains in spec/fixtures |
| Hash allocation optimization | One concise performance reason | Benchmark plan to follow-up | Old implementation and ad-hoc timer | Avoid dead implementation in tests |
| Test section dividers | Only where they materially aid a long retained suite | None | Decorative separators in split/co-located files | New structure/test names provide navigation |
| Public API docs | Caller obligations and error/wire semantics | Product behavior to specs | Restatements of signatures | Follow comment standard |

## Dependency and generated-artifact disposition

Core must continue depending only on portable crates. The proposed rewrite removes dependencies
with zero remaining production/test consumers and does not add a dependency. `serde_json` remains
only if final E2EE JSON tests need it as a dev dependency. `proptest` leaves with the dead legacy
collision/direction mechanisms; retained naming properties will use deterministic tables unless a
property test proves a distinct failure class.

No generated file is edited. Because no UniFFI semantic symbol changes, generated Swift/Kotlin
source should remain semantically stable; the final workflow will still rebuild Rust native
libraries/bindings with `just build-rust-ios` and `just build-rust-android` and compile both shells.

## Verification plan after implementation

1. Focused: `cargo test -p futo-notes-core` with nonzero count and every Fast ledger row reconciled.
2. Cross-language: conformance generator check, editor minimal suite, drift check, and Rust model
   conformance.
3. Consumers: `cargo test -p futo-notes-model`, `-store`, `-sync`, `-ffi` and Tauri tests/check.
4. Full: `just test-rust-full`, dependency guard, `pnpm exec tsc --noEmit`, `just build`, then
   `just check`.
5. Real infrastructure: full `just test-cross-platform` against an isolated server; any cumulative
   timeout is investigated without loosening assertions or masking failure.
6. Native/generated: rebuild FFI for iOS/Android, `just build-ios-native`,
   `just build-android-native`, and `just test-android-native`.
7. Final whole-scope architecture audit, complete refactoring-standard reread, accounting, and
   Gate B/C reviews.

## First-green checkpoint and Gate B architecture packet

The replacement first reached its public contract on 2026-07-15. This checkpoint deliberately
removes the obsolete center and migrates consumers before the final file extraction; green tests
do not make the two remaining warehouses architecturally complete.

### First-green results

| Command/suite | Result |
| --- | --- |
| `cargo test -p futo-notes-core` | **Pass:** 99/99 meaningful tests (96 owner-local Fast, 1 path conformance, 2 assembled public-contract); 0 ignored |
| `cargo test -p futo-notes-store` | **Pass:** 26/26, including both unique-ID acceptance guards |
| `cargo test -p futo-notes-sync` | **Pass:** 46/46 default tests; 27 isolated-server tests ignored by the default command |
| `cargo test -p futo-notes-model` | **Pass:** 28/28 including conformance |
| `cargo test -p futo-notes-ffi` | **Pass:** 1/1 |
| `just test-rust-full` | **Pass:** core, model, search, store, sync, FFI, and Tauri workspace suites |
| `pnpm exec tsx tests/conformance/generate.mjs --check` | **Pass** |
| `pnpm run test:editor:minimal` | **Pass:** 243/243 |
| `pnpm exec tsc --noEmit` | **Pass** |
| `just test-cross-platform` with `FUTO_NOTES_E2EE_SERVER_REPO=/Users/mason/futo-notes-server` | **Pass:** 30/30 desktop↔desktop scenarios; both cumulative baseline timeouts passed in-suite |

The first cross-platform attempt stopped before scenarios because its default server checkout path
did not exist. The successful rerun supplied the existing isolated checkout explicitly and used
the same temporary cached Bun executable as the baseline. This was prerequisite routing only; no
server checkout or system installation was changed.

### First-green accounting

The accounting helper was run against the explicit current files because its directory expansion
also includes tracked paths deleted by the rewrite.

| Metric | Baseline | First green | Delta |
| --- | ---: | ---: | ---: |
| Production lines | 1,672 | 1,145 | -527 (-31.5%) |
| Test lines | 2,957 | 1,285 | -1,672 (-56.5%) |
| Source files counted | 11 | 9 | -2 |
| Meaningful default core tests | 192 | 99 | -93, with all 96 Fast promises retained and dead seams removed |
| Ignored core tests | 3 | 0 | -3; benchmark work remains explicitly queued |

### Current first-green tree audit

| Current file | Production | Test | Single responsibility assessment | State/lifecycle | Gate B finding |
| --- | ---: | ---: | --- | --- | --- |
| `src/lib.rs` | 6 | 0 | Public crate module facade | None | Conforms |
| `src/conflict_names.rs` | 113 | 170 | Deterministic date/object conflict-copy filenames | None | Cohesive; keep |
| `src/files/mod.rs` | 683 | 437 | Currently combines filenames, paths, timestamps, temp installation, crash recovery, blobs, and renames | One process-local temp sequence only | **Warehouse:** split by the approved capability boundaries |
| `src/e2ee/mod.rs` | 251 | 224 | Currently combines cipher, KDF, note frame, and vault-key workflow | CSPRNG only | **Warehouse:** retain facade, extract four capabilities |
| `src/hash.rs` | 24 | 142 | Exact-byte SHA-256 | None | Cohesive; keep; ignored timers removed |
| `src/image.rs` | 41 | 45 | Canonical image/syncable classification | None | Cohesive; keep; trim stale invariant history in Stage 4 |
| `src/merge.rs` | 27 | 162 | Three-way text merge | None | Cohesive; keep |
| `tests/public_contract.rs` | 0 | 76 | Two cross-capability durable round trips | Test filesystem only | Coherent assembled boundary; keep |
| `tests/path_safety_conformance.rs` | 0 | 29 | Shared TS/Rust hostile-path corpus | None | Correct boundary; keep |

### Proposed Gate B extraction

Apply the Gate A target tree, with these explicit dependency decisions:

- `files/mod.rs`: declarations and intentional re-exports only.
- `files/filenames.rs`: title rules plus case/Unicode filename identity.
- `files/paths.rs`: note/app-data validation, note-ID parsing, and incoming-path triage; depends on
  `filenames` and canonical `image` classification.
- `files/timestamps.rs`: wall-clock and filesystem mtime conversion.
- `files/atomic_write.rs`: complete temp writes, atomic no-replace creation, and temp-hop rename.
  It receives paths/bytes explicitly and calls the parked-install transaction; it owns no vault.
- `files/parked_backup.rs`: collision-safe replace installation, recovery sidecars, and bootstrap
  sweep. It owns the one process-local hidden-name sequence and exposes only `pub(super)` install
  machinery plus the public recovery result/API. No cache, task, or ambient root is introduced.
- `files/blob_file.rs`: exact binary base64 transport over `atomic_write::write_atomic_bytes`.
- `e2ee/mod.rs`: the stable public contract (`E2eeError`, constants, re-exports) only.
- `e2ee/cipher.rs`: CSPRNG material and AES-256-GCM; fixed-IV entry remains private to tests.
- `e2ee/password_key.rs`: PBKDF2-HMAC-SHA256 derivation.
- `e2ee/note_frame.rs`: V2 encoder plus V2/V1 decoder and literal legacy vectors.
- `e2ee/vault_key.rs`: KeyMaterial JSON plus wrap/unwrap orchestration over cipher/password modules.

Tests move with their owning capability. The two assembled tests and the conformance fixture remain
integration tests because they catch distinct cross-capability/cross-language failures. Expected
production cost is limited to module declarations, re-exports, and explicit `pub(super)` seams
(roughly 20–50 lines); the benefit is replacing 683-line and 251-line warehouses with files whose
names expose their independent safety/wire contracts. `LocalNoteStore` and `SyncSession` remain the
only lifecycle owners; no extraction receives their state or introduces a second owner.

Mason approved Gate B on 2026-07-15 and asked for a whole-scope comment audit. The approved
disposition removes comments that translate names, signatures, or test syntax; keeps only concise
wire-compatibility discrimination and crash/data-safety ordering that structure cannot express;
and leaves incident history in this ledger rather than source narration.

## Final extraction and Gate C evidence

The approved target tree is now the worktree tree. `files/mod.rs` and `e2ee/mod.rs` contain only
private module declarations, the intentional public re-exports, and the stable `E2eeError` type.
Every implementation test is co-located with its capability; only the assembled durable round
trips and shared path fixture remain under `tests/`. The removed sync/invariant warehouses have no
remaining module declaration or consumer import.

### Final accounting

| Metric | Baseline | Final | Delta |
| --- | ---: | ---: | ---: |
| Production lines | 1,672 | 1,083 | -589 (-35.2%) |
| Test lines | 2,957 | 1,331 | -1,626 (-55.0%) |
| Source files counted | 11 | 19 | +8 focused owner files |
| Meaningful default core tests | 192 | 100 | 97 owner-local + 1 conformance + 2 assembled; dead seams removed |
| Ignored core tests | 3 | 0 | Three wall-clock probes are queued as benchmark work |

The largest production file is the single-owner 221-line `files/parked_backup.rs`; its recovery
entry point is a 19-line orchestration over named directory scanning, per-backup recovery,
orphan-sidecar cleanup, and bounded recursion. The next largest files are `files/paths.rs` (144),
`files/filenames.rs` (127), `files/atomic_write.rs` (120), and `conflict_names.rs` (109). No module
entry point is an implementation warehouse.

### Final architecture and comment audit

- Core owns only portable stateless capabilities. Durable vault/search/watcher state remains in
  `LocalNoteStore`; connection/checkpoint/live-task state remains in `SyncSession`.
- No removed `core::sync`, `invariants`, monolithic `files.rs`/`e2ee.rs`, or core unique-ID owner
  remains in code, specs, contributor guidance, scripts, or consumer comments. Historical paths
  remain only in this test-disposition record.
- The drift registry now points filename/path contracts at their focused modules and unique-ID
  suffixing at `futo-notes-store::paths`.
- Core source comments were audited in full. Comments that restated function names, signatures,
  tests, syntax, or implementation history were removed. The nine remaining comment blocks cover
  the cross-language image lock, V1 frame discrimination, or crash/durability ordering that names
  cannot express.
- `rayon`, `rand_chacha`, and `proptest` were removed from core; `serde_json` is test-only. Normal
  dependency guards confirm core/model/sync do not reach Tantivy or ORT and FFI does not reach ORT.

### Final verification

| Command | Result |
| --- | --- |
| `cargo test -p futo-notes-core` | **Pass:** 97 owner-local + 1 path conformance + 2 public contract; 0 ignored |
| `cargo test -p futo-notes-model -p futo-notes-store -p futo-notes-sync -p futo-notes-ffi` | **Pass:** model 28, store 26, sync 46 default, FFI 1; sync's 27 infrastructure tests remain intentionally ignored by default |
| `just test-rust-full` | **Pass:** every default workspace suite; core 100, model 28, search 8, store 26, sync 46, FFI 1, Tauri 26 |
| Conformance generator + editor minimal | **Pass:** fixtures current; 243/243 editor tests |
| `pnpm exec tsc --noEmit` + dependency guard | **Pass:** typecheck clean; portable dependency boundaries intact |
| `just build` | **Pass:** TypeScript and production Vite build |
| `just spec-gaps` then `just check` | **Pass:** generated 12-gap index current; architecture/drift/debt, lint, Svelte, format, 788 unit tests, 341 editor tests, typecheck, and build |
| Full isolated `just test-cross-platform` | **Pass:** 30/30 cumulative desktop↔desktop scenarios, including both baseline timeout cases |
| `just build-rust-ios` | **Pass:** device, arm64 simulator, x86_64 simulator, host metadata, Swift bindings, and XCFramework; optional `swiftformat` absent warning only |
| `just build-ios-native` | **Pass:** embedded editor and generic iOS Simulator shell build (`BUILD SUCCEEDED`) |
| `just build-rust-android` | **Environment block before compilation:** no Android SDK/NDK, `cargo-ndk`, or installed Android Rust targets in this host environment |
| `just build-android-native` / `just test-android-native` | **Not runnable for the same prerequisite block; no code failure observed or masked** |
| `cargo fmt -p futo-notes-core -- --check` + `git diff --check` | **Pass** |

The Android block would require system-wide SDK/NDK, cargo tool, and Rust-target installation,
which is outside the repository mutation authorized by this rewrite. All repository-local and
available platform gates are green.

## Legacy-test disposition ledger

All **195** legacy tests were read and translated before implementation. Totals:

| Fast | Acceptance | Core | Obsolete | Follow-up | Total |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 96 | 5 | 0 | 91 | 3 | 195 |

Final reconciliation: **101 Pass, 91 Removed, 3 Queued, 0 Pending**.

| Legacy file:test | Plain-English promise | Evidence/source | Classification | Planned guard/disposition | Baseline | Final |
| --- | --- | --- | --- | --- | --- | --- |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::aes_gcm_rejects_short_ciphertext` | At the encrypted-sync primitive boundary, AES-GCM rejects short ciphertext. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::cipher::tests::aes_gcm_rejects_short_ciphertext | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::aes_gcm_rejects_tampered_ciphertext` | At the encrypted-sync primitive boundary, AES-GCM rejects tampered ciphertext. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::cipher::tests::aes_gcm_rejects_tampered_ciphertext | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::aes_gcm_rejects_wrong_key` | At the encrypted-sync primitive boundary, AES-GCM rejects wrong key. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::cipher::tests::aes_gcm_rejects_wrong_key | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::aes_gcm_round_trip_fixed_iv` | At the encrypted-sync primitive boundary, AES-GCM round trip fixed IV. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::cipher::tests::aes_gcm_round_trip_fixed_iv | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::aes_gcm_round_trip_random_iv` | At the encrypted-sync primitive boundary, AES-GCM round trip random IV. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::cipher::tests::aes_gcm_round_trip_random_iv | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::full_pipeline_round_trip` | At the encrypted-sync primitive boundary, full pipeline round trip. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::vault_key::tests::full_pipeline_round_trip | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::key_material_serde_accepts_updated_at_from_server` | At the encrypted-sync primitive boundary, key material JSON serialization accepts updated at from server. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::vault_key::tests::key_material_serde_accepts_updated_at_from_server | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::key_material_serde_round_trip` | At the encrypted-sync primitive boundary, key material JSON serialization round trip. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::vault_key::tests::key_material_serde_round_trip | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::merge_clean_non_overlapping` | At the encrypted-sync primitive boundary, merge clean non overlapping. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the unrelated E2EE merge forwarding facade; futo-notes-sync imports the canonical merge capability directly. | Pass | Removed |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::merge_conflict_on_overlap` | At the encrypted-sync primitive boundary, merge conflict on overlap. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the unrelated E2EE merge forwarding facade; futo-notes-sync imports the canonical merge capability directly. | Pass | Removed |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::pbkdf2_hmac_sha256_rfc7914_vector_1` | At the encrypted-sync primitive boundary, PBKDF2-HMAC-SHA256 matches the RFC 7914 vector. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::password_key::tests::pbkdf2_hmac_sha256_rfc7914_vector_1 | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::unpack_rejects_empty` | At the encrypted-sync primitive boundary, unpack rejects empty. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::unpack_rejects_empty | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::unpack_rejects_truncated_v2` | At the encrypted-sync primitive boundary, unpack rejects truncated V2. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::unpack_rejects_truncated_v2 | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::unpack_rejects_unknown_frame_version` | At the encrypted-sync primitive boundary, unpack rejects unknown frame version. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::unpack_rejects_unknown_frame_version | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::unpack_rejects_v2_out_of_bounds` | At the encrypted-sync primitive boundary, unpack rejects V2 out of bounds. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::unpack_rejects_v2_out_of_bounds | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::unwrap_rejects_unsupported_kdf` | At the encrypted-sync primitive boundary, unwrap rejects unsupported kdf. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::vault_key::tests::unwrap_rejects_unsupported_kdf | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::unwrap_rejects_wrong_password` | At the encrypted-sync primitive boundary, unwrap rejects wrong password. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::vault_key::tests::unwrap_rejects_wrong_password | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v1_byte_layout_matches_ts` | At the encrypted-sync primitive boundary, v1 byte layout matches ts. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the unused V1 encoder; preserve decode-only compatibility with a literal legacy frame in e2ee::note_frame tests. | Pass | Removed |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v1_decoded_by_unpack` | At the encrypted-sync primitive boundary, v1 decoded by unpack. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::v1_decoded_by_unpack | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v2_byte_layout_matches_ts` | At the encrypted-sync primitive boundary, v2 byte layout matches ts. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::v2_byte_layout_matches_ts | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v2_round_trip_basic` | At the encrypted-sync primitive boundary, v2 round trip basic. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::v2_round_trip_basic | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v2_round_trip_empty_content` | At the encrypted-sync primitive boundary, v2 round trip empty content. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::v2_round_trip_empty_content | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v2_round_trip_nested_path` | At the encrypted-sync primitive boundary, v2 round trip nested path. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::v2_round_trip_nested_path | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::v2_round_trip_unicode_in_path_and_content` | At the encrypted-sync primitive boundary, v2 round trip unicode in path and content. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::note_frame::tests::v2_round_trip_unicode_in_path_and_content | Pass | Pass |
| `crates/futo-notes-core/src/e2ee.rs::e2ee::tests::wrap_unwrap_round_trip` | At the encrypted-sync primitive boundary, wrap unwrap round trip. | Legacy test body + applicable spec/consumer | **Fast** | e2ee::vault_key::tests::wrap_unwrap_round_trip | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::appdata_paths_reject_unix_and_windows_traversal` | At the durable-file boundary, app-data paths reject unix and windows traversal. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::appdata_paths_reject_unix_and_windows_traversal | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::atomic_text_write_replaces_content_without_temp_litter` | At the durable-file boundary, atomic text write replaces content without temp litter. | Legacy test body + applicable spec/consumer | **Fast** | files::atomic_write::tests::atomic_text_write_replaces_content_without_temp_litter | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::binary_blob_round_trip_is_not_utf8_dependent` | At the durable-file boundary, binary blob round trip is not UTF-8 dependent. | Legacy test body + applicable spec/consumer | **Fast** | files::blob_file::tests::binary_blob_round_trip_is_not_utf8_dependent | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::incoming_name_limit_is_bytes_not_ui_title_length` | At the durable-file boundary, incoming name limit is bytes not ui title length. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::incoming_name_limit_is_bytes_not_ui_title_length | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::incoming_paths_have_one_accept_heal_ignore_reject_decision` | At the durable-file boundary, incoming paths have one accept heal ignore reject decision. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::incoming_paths_have_one_accept_heal_ignore_reject_decision | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::modification_time_round_trips_in_milliseconds` | At the durable-file boundary, modification time round trips in milliseconds. | Legacy test body + applicable spec/consumer | **Fast** | files::timestamps::tests::modification_time_round_trips_in_milliseconds | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::note_id_parsing_is_strict_and_platform_neutral` | At the durable-file boundary, note id parsing is strict and platform neutral. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::note_id_parsing_is_strict_and_platform_neutral | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::note_paths_preserve_layout_and_refuse_escape` | At the durable-file boundary, note paths preserve layout and refuse escape. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::note_paths_preserve_layout_and_refuse_escape | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::recover_cleans_orphan_sidecars_and_recurses_into_folders` | At the durable-file boundary, recover cleans orphan sidecars and recurses into folders. | Legacy test body + applicable spec/consumer | **Fast** | files::parked_backup::tests::{recover_removes_orphan_sidecars,recover_recurses_into_folders} | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::recover_does_not_follow_directory_symlinks_into_a_loop` | At the durable-file boundary, recover does not follow directory symlinks into a loop. | Legacy test body + applicable spec/consumer | **Fast** | files::parked_backup::tests::recover_does_not_follow_directory_symlinks_into_a_loop | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::recover_drops_a_backup_identical_to_the_returned_note` | At the durable-file boundary, recover drops a backup identical to the returned note. | Legacy test body + applicable spec/consumer | **Fast** | files::parked_backup::tests::recover_drops_a_backup_identical_to_the_returned_note | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::recover_restores_a_note_stranded_in_a_parked_backup` | At the durable-file boundary, recover restores a note stranded in a parked backup. | Legacy test body + applicable spec/consumer | **Fast** | files::parked_backup::tests::recover_restores_a_note_stranded_in_a_parked_backup | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::recover_returns_a_divergent_backup_as_terminal` | At the durable-file boundary, recover returns a divergent backup as terminal. | Legacy test body + applicable spec/consumer | **Fast** | files::parked_backup::tests::recover_returns_a_divergent_backup_as_terminal | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::temp_hop_changes_the_directory_entry_without_losing_bytes` | At the durable-file boundary, temp hop changes the directory entry without losing bytes. | Legacy test body + applicable spec/consumer | **Fast** | files::atomic_write::tests::temp_hop_changes_the_directory_entry_without_losing_bytes | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::title_rules_match_the_public_cross_platform_contract` | At the durable-file boundary, title rules match the public cross platform contract. | Legacy test body + applicable spec/consumer | **Fast** | files::filenames::tests::title_rules_match_the_public_cross_platform_contract | Pass | Pass |
| `crates/futo-notes-core/src/files.rs::files::tests::unique_ids_fold_case_and_unicode_normalization` | At the durable-file boundary, unique ids fold case and unicode normalization. | Legacy test body + applicable spec/consumer | **Acceptance** | futo-notes-store::tests::create_never_clobbers_a_concurrent_writer_at_the_chosen_id and rename_never_overwrites_a_case_or_unicode_colliding_destination. | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::bench_hash_4kb` | At the content-hash boundary, bench hash 4kb. | Legacy test body + applicable spec/consumer | **Follow-up** | Replace the ignored wall-clock probe with a repeatable release-profile hash benchmark and recorded input sizes. | Ignored by default (3 total) | Queued |
| `crates/futo-notes-core/src/hash.rs::hash::tests::bench_hash_64kb` | At the content-hash boundary, bench hash 64kb. | Legacy test body + applicable spec/consumer | **Follow-up** | Replace the ignored wall-clock probe with a repeatable release-profile hash benchmark and recorded input sizes. | Ignored by default (3 total) | Queued |
| `crates/futo-notes-core/src/hash.rs::hash::tests::bench_hash_small` | At the content-hash boundary, bench hash small. | Legacy test body + applicable spec/consumer | **Follow-up** | Replace the ignored wall-clock probe with a repeatable release-profile hash benchmark and recorded input sizes. | Ignored by default (3 total) | Queued |
| `crates/futo-notes-core/src/hash.rs::hash::tests::binary_bytes_all_values` | At the content-hash boundary, binary bytes all values. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::binary_bytes_all_values | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::binary_looking_content` | At the content-hash boundary, binary looking content. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::binary_looking_content | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::bytes_matches_string` | At the content-hash boundary, bytes matches string. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::bytes_matches_string | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::content_with_bom_utf16_bytes` | At the content-hash boundary, content with bom UTF-16 bytes. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::content_with_bom_utf16_bytes | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::content_with_bom_utf8` | At the content-hash boundary, content with bom UTF-8. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::content_with_bom_utf8 | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::deterministic_across_calls` | At the content-hash boundary, deterministic across calls. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::deterministic_across_calls | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::empty_string` | At the content-hash boundary, empty string. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::empty_string | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::known_vector` | At the content-hash boundary, known vector. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::known_vector | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::large_content_1mb` | At the content-hash boundary, large content 1mb. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::large_content_1mb | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::large_content_bytes_1mb` | At the content-hash boundary, large content bytes 1mb. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::large_content_bytes_1mb | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::mixed_line_endings` | At the content-hash boundary, mixed line endings. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::mixed_line_endings | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::null_bytes_in_content` | At the content-hash boundary, null bytes in content. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::null_bytes_in_content | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::single_char_differences` | At the content-hash boundary, single char differences. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::single_char_differences | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::unicode` | At the content-hash boundary, unicode. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::unicode | Pass | Pass |
| `crates/futo-notes-core/src/hash.rs::hash::tests::whitespace_only_content` | At the content-hash boundary, whitespace only content. | Legacy test body + applicable spec/consumer | **Fast** | hash::tests::whitespace_only_content | Pass | Pass |
| `crates/futo-notes-core/src/image.rs::image::tests::canonical_set_is_ten` | At the canonical image-classification boundary, canonical set is ten. | Legacy test body + applicable spec/consumer | **Fast** | image::tests::canonical_set_is_ten | Pass | Pass |
| `crates/futo-notes-core/src/image.rs::image::tests::extension_is_after_last_dot` | At the canonical image-classification boundary, extension is after last dot. | Legacy test body + applicable spec/consumer | **Fast** | image::tests::extension_is_after_last_dot | Pass | Pass |
| `crates/futo-notes-core/src/image.rs::image::tests::legacy_extensions_are_not_images` | At the canonical image-classification boundary, legacy extensions are not images. | Legacy test body + applicable spec/consumer | **Fast** | image::tests::legacy_extensions_are_not_images | Pass | Pass |
| `crates/futo-notes-core/src/image.rs::image::tests::recognizes_canonical_extensions` | At the canonical image-classification boundary, recognizes canonical extensions. | Legacy test body + applicable spec/consumer | **Fast** | image::tests::recognizes_canonical_extensions | Pass | Pass |
| `crates/futo-notes-core/src/image.rs::image::tests::syncable_classifies_notes_images_and_ignores_the_rest` | At the canonical image-classification boundary, syncable classifies notes images and ignores the rest. | Legacy test body + applicable spec/consumer | **Fast** | image::tests::syncable_classifies_notes_images_and_ignores_the_rest | Pass | Pass |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::all_invariants_multiple_violations` | The legacy NoteRecord audit API promises, all invariants multiple violations. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::all_pass_scenario` | The legacy NoteRecord audit API promises, all pass scenario. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::blob_extension_all_image_types` | The legacy NoteRecord audit API promises, blob extension all image types. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::blob_extension_case_insensitive_extensions` | The legacy NoteRecord audit API promises, blob extension case insensitive extensions. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::blob_extension_image_marked_not_blob` | The legacy NoteRecord audit API promises, blob extension image marked not blob. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::blob_extension_mismatch` | The legacy NoteRecord audit API promises, blob extension mismatch. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::blob_extension_non_image_marked_blob` | The legacy NoteRecord audit API promises, blob extension non image marked blob. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::blob_extension_pass` | The legacy NoteRecord audit API promises, blob extension pass. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_empty_filename` | The legacy NoteRecord audit API promises, content hash empty filename. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_empty_hash` | The legacy NoteRecord audit API promises, content hash empty hash. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_parity_blob` | The legacy NoteRecord audit API promises, content hash parity blob. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_parity_empty_file` | The legacy NoteRecord audit API promises, content hash parity empty file. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_parity_empty_file_wrong_hash` | The legacy NoteRecord audit API promises, content hash parity empty file wrong hash. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_parity_mismatch` | The legacy NoteRecord audit API promises, content hash parity mismatch. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_parity_missing_file` | The legacy NoteRecord audit API promises, content hash parity missing file. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::content_hash_parity_pass` | The legacy NoteRecord audit API promises, content hash parity pass. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::duplicate_check_large_list_no_duplicates` | The legacy NoteRecord audit API promises, duplicate check large list no duplicates. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::duplicate_check_large_list_with_duplicates` | The legacy NoteRecord audit API promises, duplicate check large list with duplicates. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::duplicate_filenames_case_differs` | The legacy NoteRecord audit API promises, duplicate filenames case differs. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::duplicate_filenames_detected` | The legacy NoteRecord audit API promises, duplicate filenames detected. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::no_duplicate_filenames` | The legacy NoteRecord audit API promises, no duplicate filenames. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::orphaned_files_detected` | The legacy NoteRecord audit API promises, orphaned files detected. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::orphaned_files_detects_orphan_images` | The legacy NoteRecord audit API promises, orphaned files detects orphan images. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::orphaned_files_ignores_dotfiles` | The legacy NoteRecord audit API promises, orphaned files ignores dotfiles. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::orphaned_files_ignores_non_md_non_image` | The legacy NoteRecord audit API promises, orphaned files ignores non md non image. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::orphaned_files_nonexistent_dir` | The legacy NoteRecord audit API promises, orphaned files nonexistent dir. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::orphaned_files_skips_dotfiles` | The legacy NoteRecord audit API promises, orphaned files skips dotfiles. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::tombstone_empty_sets` | The legacy NoteRecord audit API promises, tombstone empty sets. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::tombstone_large_sets_no_overlap` | The legacy NoteRecord audit API promises, tombstone large sets no overlap. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::tombstone_large_sets_with_overlap` | The legacy NoteRecord audit API promises, tombstone large sets with overlap. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::tombstone_no_overlap` | The legacy NoteRecord audit API promises, tombstone no overlap. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::tombstone_overlap_detected` | The legacy NoteRecord audit API promises, tombstone overlap detected. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::tombstone_single_item_overlap` | The legacy NoteRecord audit API promises, tombstone single item overlap. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::version_max_to_max` | The legacy NoteRecord audit API promises, version max to max. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::version_max_to_zero` | The legacy NoteRecord audit API promises, version max to zero. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::version_non_decreasing_ok` | The legacy NoteRecord audit API promises, version non decreasing ok. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::version_one_regression` | The legacy NoteRecord audit API promises, version one regression. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::version_regression_detected` | The legacy NoteRecord audit API promises, version regression detected. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/invariants.rs::invariants::tests::version_zero_to_zero` | The legacy NoteRecord audit API promises, version zero to zero. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/src/merge.rs::merge::tests::additions_at_different_positions` | At the three-way text-merge boundary, additions at different positions. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::additions_at_different_positions | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::all_three_identical_returns_clean` | At the three-way text-merge boundary, all three identical returns clean. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::all_three_identical_returns_clean | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::both_sides_identical_changes_merge_cleanly` | At the three-way text-merge boundary, both sides identical changes merge cleanly. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::both_sides_identical_changes_merge_cleanly | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::deletions_at_different_positions` | At the three-way text-merge boundary, deletions at different positions. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::deletions_at_different_positions | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::empty_base_both_add_different_content_conflicts` | At the three-way text-merge boundary, empty base both add different content conflicts. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::empty_base_both_add_different_content_conflicts | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::empty_base_both_add_same_content_merges` | At the three-way text-merge boundary, empty base both add same content merges. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::empty_base_both_add_same_content_merges | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::large_file_small_edits_different_regions` | At the three-way text-merge boundary, large file small edits different regions. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::large_file_small_edits_different_regions | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::non_overlapping_edits_merge_cleanly` | At the three-way text-merge boundary, non overlapping edits merge cleanly. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::non_overlapping_edits_merge_cleanly | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::one_side_unchanged_takes_other` | At the three-way text-merge boundary, one side unchanged takes other. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::one_side_unchanged_takes_other | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::other_side_unchanged_takes_changed` | At the three-way text-merge boundary, other side unchanged takes changed. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::other_side_unchanged_takes_changed | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::overlapping_edits_produce_conflict` | At the three-way text-merge boundary, overlapping edits produce conflict. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::overlapping_edits_produce_conflict | Pass | Pass |
| `crates/futo-notes-core/src/merge.rs::merge::tests::qa_scenario4_paragraph_merge_no_trailing_newline` | At the three-way text-merge boundary, qa scenario4 paragraph merge no trailing newline. | Legacy test body + applicable spec/consumer | **Fast** | merge::tests::qa_scenario4_paragraph_merge_no_trailing_newline | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::both_changed_different` | The legacy core sync surface promises, both changed different. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::both_changed_same_content` | The legacy core sync surface promises, both changed same content. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::client_changed` | The legacy core sync surface promises, client changed. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collides_but_differs_detects_case_and_norm_only` | The legacy core sync surface promises, collides but differs detects case and norm only. | Legacy test body + applicable spec/consumer | **Fast** | files::filenames::tests::collides_but_differs_detects_case_and_norm_only | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_basic` | The legacy core sync surface promises, collision basic. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_conflict_filename_does_not_stack_on_a_parked_copy` | The legacy core sync surface promises, collision conflict filename does not stack on a parked copy. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::collision_conflict_filename_does_not_stack_on_a_parked_copy | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_conflict_filename_handles_degenerate_object_id` | The legacy core sync surface promises, collision conflict filename handles degenerate object id. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::collision_conflict_filename_handles_degenerate_object_id | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_conflict_filename_independent_of_namespace_set` | The legacy core sync surface promises, collision conflict filename independent of namespace set. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::collision_conflict_filename_independent_of_namespace_set | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_conflict_filename_is_pure_function_of_object_id` | The legacy core sync surface promises, collision conflict filename is pure function of object id. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::collision_conflict_filename_is_pure_function_of_object_id | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_conflict_filename_peels_deep_stacks_flat` | The legacy core sync surface promises, collision conflict filename peels deep stacks flat. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::collision_conflict_filename_peels_deep_stacks_flat | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_conflict_filename_preserves_extension` | The legacy core sync surface promises, collision conflict filename preserves extension. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::collision_conflict_filename_preserves_extension | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_key_folds_case` | The legacy core sync surface promises, collision key folds case. | Legacy test body + applicable spec/consumer | **Fast** | files::filenames::tests::collision_key_folds_case | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_key_folds_nfc_nfd` | The legacy core sync surface promises, collision key folds NFC NFD. | Legacy test body + applicable spec/consumer | **Fast** | files::filenames::tests::collision_key_folds_nfc_nfd | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_multiple` | The legacy core sync surface promises, collision multiple. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_no_conflict` | The legacy core sync surface promises, collision no conflict. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_no_extension` | The legacy core sync surface promises, collision no extension. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_preserves_md_extension` | The legacy core sync surface promises, collision preserves md extension. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::collision_resolution_never_reuses_an_existing_filename` | The legacy core sync surface promises, collision resolution never reuses an existing filename. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_filename_basic` | The legacy core sync surface promises, conflict filename basic. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_filename_basic | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_filename_does_not_stack_on_a_parked_copy` | The legacy core sync surface promises, conflict filename does not stack on a parked copy. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_filename_does_not_stack_on_a_parked_copy | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_filename_multiple_collisions` | The legacy core sync surface promises, conflict filename multiple collisions. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_filename_multiple_collisions | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_filename_no_extension` | The legacy core sync surface promises, conflict filename no extension. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_filename_no_extension | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_filename_preserves_non_md_extension` | The legacy core sync surface promises, conflict filename preserves non md extension. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_filename_preserves_non_md_extension | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_filename_with_collision` | The legacy core sync surface promises, conflict filename with collision. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_filename_with_collision | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_naming_is_idempotent_across_rounds` | The legacy core sync surface promises, conflict naming is idempotent across rounds. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_naming_is_idempotent_across_rounds | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_naming_leaves_user_title_with_nested_parens_untouched` | The legacy core sync surface promises, conflict naming leaves user title with nested parens untouched. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_naming_leaves_user_title_with_nested_parens_untouched | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_naming_peels_date_counter_suffix` | The legacy core sync surface promises, conflict naming peels date counter suffix. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_naming_peels_date_counter_suffix | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_naming_preserves_extension_when_stripping_stack` | The legacy core sync surface promises, conflict naming preserves extension when stripping stack. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_naming_preserves_extension_when_stripping_stack | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::conflict_naming_preserves_user_title_that_mentions_conflict` | The legacy core sync surface promises, conflict naming preserves user title that mentions conflict. | Legacy test body + applicable spec/consumer | **Fast** | conflict_names::tests::conflict_naming_preserves_user_title_that_mentions_conflict | Pass | Pass |
| `crates/futo-notes-core/src/sync.rs::sync::tests::convergence_case_sensitive` | The legacy core sync surface promises, convergence case sensitive. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::convergence_detected` | The legacy core sync surface promises, convergence detected. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::convergence_empty_strings` | The legacy core sync surface promises, convergence empty strings. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::convergence_one_empty` | The legacy core sync surface promises, convergence one empty. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::convergence_whitespace_matters` | The legacy core sync surface promises, convergence whitespace matters. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_all_empty_strings` | The legacy core sync surface promises, direction all empty strings. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_client_empty_server_has_value` | The legacy core sync surface promises, direction client empty server has value. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_exhaustive_permutations` | The legacy core sync surface promises, direction exhaustive permutations. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_last_sync_empty_both_have_values` | The legacy core sync surface promises, direction last sync empty both have values. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_last_sync_empty_both_same` | The legacy core sync surface promises, direction last sync empty both same. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_matches_change_flags_for_arbitrary_hashes` | The legacy core sync surface promises, direction matches change flags for arbitrary hashes. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_not_symmetric` | The legacy core sync surface promises, direction not symmetric. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_server_empty_client_has_value` | The legacy core sync surface promises, direction server empty client has value. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::direction_with_real_hashes` | The legacy core sync surface promises, direction with real hashes. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::empty_sync_request` | The legacy core sync surface promises, empty sync request. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::neither_changed` | The legacy core sync surface promises, neither changed. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::no_convergence` | The legacy core sync surface promises, no convergence. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::rename_match_one_empty_one_not` | The legacy core sync surface promises, rename match one empty one not. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::rename_match_same_hash` | The legacy core sync surface promises, rename match same hash. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::rename_match_very_long_hashes` | The legacy core sync surface promises, rename match very long hashes. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::rename_match_whitespace_only` | The legacy core sync surface promises, rename match whitespace only. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::rename_no_match_different` | The legacy core sync surface promises, rename no match different. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::rename_no_match_empty` | The legacy core sync surface promises, rename no match empty. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::server_changed` | The legacy core sync surface promises, server changed. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::sync_check_serde_roundtrip` | The legacy core sync surface promises, sync check JSON serialization roundtrip. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::sync_check_status_json_format` | The legacy core sync surface promises, sync check status json format. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::sync_request_serde_roundtrip` | The legacy core sync surface promises, sync request JSON serialization roundtrip. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::sync_request_without_inventory` | The legacy core sync surface promises, sync request without inventory. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::sync_request_without_optional_fields` | The legacy core sync surface promises, sync request without optional fields. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/src/sync.rs::sync::tests::sync_response_serde_roundtrip` | The legacy core sync surface promises, sync response JSON serialization roundtrip. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::appdata_traversal_comprehensive` | At the assembled core public boundary, app-data traversal comprehensive. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::appdata_traversal_comprehensive | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::atomic_write_hash_verify_unicode` | At the assembled core public boundary, atomic write hash verify unicode. | Legacy test body + applicable spec/consumer | **Acceptance** | tests/public_contract.rs::atomic_write_preserves_exact_hashable_text. | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::blob_hash_parity_binary_content` | At the assembled core public boundary, blob hash parity binary content. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::bug_write_atomic_text_long_filename_exceeds_fs_limit` | At the assembled core public boundary, bug write atomic text long filename exceeds fs limit. | Legacy test body + applicable spec/consumer | **Fast** | files::atomic_write::tests::bug_write_atomic_text_long_filename_exceeds_fs_limit | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::convergence_implies_both_changed` | At the assembled core public boundary, convergence implies both changed. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::full_invariant_stress_100_notes` | At the assembled core public boundary, full invariant stress 100 notes. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::full_note_lifecycle_adversarial_titles` | At the assembled core public boundary, full note lifecycle adversarial titles. | Legacy test body + applicable spec/consumer | **Acceptance** | tests/public_contract.rs::durable_note_round_trip_preserves_title_path_content_and_hash. | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::hash_invariant_one_tampered` | At the assembled core public boundary, hash invariant one tampered. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::hash_invariant_round_trip_many_notes` | At the assembled core public boundary, hash invariant round trip many notes. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the uncalled NoteRecord/database audit mechanism; LocalNoteStore and SyncSession guard their live invariants and no supported caller can observe InvariantViolation. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::neither_changed_implies_no_convergence_needed` | At the assembled core public boundary, neither changed implies no convergence needed. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::note_id_from_filename_adversarial` | At the assembled core public boundary, note id from filename adversarial. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::note_id_from_filename_adversarial | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::rename_detection_real_content` | At the assembled core public boundary, rename detection real content. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::safe_note_path_traversal_blocked` | At the assembled core public boundary, safe note path traversal blocked. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::safe_note_path_traversal_blocked | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::safe_note_path_valid_ids` | At the assembled core public boundary, safe note path valid ids. | Legacy test body + applicable spec/consumer | **Fast** | files::paths::tests::safe_note_path_valid_ids | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::sanitize_is_idempotent` | At the assembled core public boundary, sanitize is idempotent. | Legacy test body + applicable spec/consumer | **Fast** | files::filenames::tests::sanitize_is_idempotent | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::sync_direction_real_content_changes` | At the assembled core public boundary, sync direction real content changes. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/tests/adversarial.rs::unique_id_stress_200_collisions` | At the assembled core public boundary, unique id stress 200 collisions. | Legacy test body + applicable spec/consumer | **Acceptance** | futo-notes-store::tests::create_never_clobbers_a_concurrent_writer_at_the_chosen_id and rename_never_overwrites_a_case_or_unicode_colliding_destination. | Pass | Pass |
| `crates/futo-notes-core/tests/adversarial.rs::validate_title_is_readonly` | At the assembled core public boundary, validate title is readonly. | Legacy test body + applicable spec/consumer | **Fast** | files::filenames::tests::validate_title_is_readonly | Pass | Pass |
| `crates/futo-notes-core/tests/path_safety_conformance.rs::safe_note_ids_match_the_shared_boundary_corpus` | At the cross-language path-safety boundary, safe note ids match the shared boundary corpus. | Legacy test body + applicable spec/consumer | **Acceptance** | Retain tests/path_safety_conformance.rs::safe_note_ids_match_the_shared_boundary_corpus. | Pass | Pass |
| `crates/futo-notes-core/tests/sync_cycle.rs::full_sync_cycle` | The legacy synthetic sync-cycle harness promises, full sync cycle. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |
| `crates/futo-notes-core/tests/sync_cycle.rs::rename_detection_via_hash_match` | The legacy synthetic sync-cycle harness promises, rename detection via hash match. | Legacy test body + applicable spec/consumer | **Obsolete** | Delete the pre-SyncSession DTO/direction/rename/suffix mechanism; current futo-notes-sync owns protocol state and no production caller imports this surface. | Pass | Removed |

## Contract gaps and follow-up queue

- The two cumulative desktop-desktop baseline timeouts did not reproduce after either first-green
  or final extraction: both complete 30-scenario reruns passed without timeout changes.
- Replace the three ignored hash wall-clock probes with one repeatable release-profile benchmark
  with explicit sizes and recorded comparison method.
- Add deliberate fault injection around sidecar creation, parking, final install, and cleanup.
  Existing recovery-state tests prove restart behavior but not every crash instruction boundary.
- Add literal malformed V1 and invalid-UTF-8 frame tests while retaining decode compatibility.
- No supported product behavior is currently unexecutable: wire vectors, conformance fixtures,
  store/sync behavior suites, and real-server scenarios establish the old implementation oracle.

## Review decisions

- **Gate A:** approved by Mason on 2026-07-15 with the contract, ownership model, target tree,
  dispositions, and verification plan unchanged.
- **Gate B:** approved by Mason on 2026-07-15 with the extraction proposal unchanged and a required
  whole-scope audit removing comments that merely restate names or syntax.
- **Gate C:** approved by Mason on 2026-07-15 by requesting the complete reviewed worktree be
  committed after the accounting and supported-functionality audit.
- The rewrite is committed on `refactor/core-crate`; Git and GitLab remain the authority for its
  publication state.
