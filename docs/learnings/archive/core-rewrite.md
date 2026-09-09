# FUTO Notes core contract rewrite

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/archive/core-rewrite.md
```

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
