# FUTO Notes FFI Contract Rewrite Ledger

## Rewrite state

- Stage: Gate C complete.
- Last approved gate: Gate B, approved by the user on 2026-07-16.
- Production implementation and all required Gate C verification are complete.
- Base commit: `9ecd1f521254cc4c5101fa720249f56eece62f84` (current local `main`).
- Worktree: `/Users/mason/.codex/worktrees/4aca/futo-notes` (detached at the base commit before this ledger was created).
- Initial status: clean.
- Declared scope: `crates/futo-notes-ffi`, its tests, and only direct native consumer,
  generated-binding, configuration, and documentation changes strictly required to preserve the
  current semantic contract.
- Narrowest owner: the `futo-notes-ffi` UniFFI projection boundary. The shared model, core, store,
  search, and sync crates are external collaborators, not rewrite scopes.
- Scope expansion rule: stop for explicit approval before any foundational cross-crate boundary
  change.

## Authorities read completely

Read independently from current local `main` or the named absolute source, through EOF, before
this ledger was created:

- `/Users/mason/.codex/skills/guided-contract-rewrite/SKILL.md`
- `/Users/mason/.codex/skills/contract-rewrite/SKILL.md`
- `/Users/mason/.codex/skills/contract-rewrite/references/ledger.md`
- `/Users/mason/.codex/skills/contract-rewrite/references/futo-notes.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/workflow.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/architecture-pass.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/compliance-matrix.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/observed-runs.md`
- `/Users/mason/.codex/skills/guided-contract-rewrite/references/tauri-case-study.md`
- `AGENTS.md`
- `docs/spec/AGENTS.md`
- `docs/architecture/codebase-organization.md`
- `/Users/mason/Downloads/codebase-refactoring.md`
- `justfile`
- All current behavioral specifications under `docs/spec/`: `README.md`, `app.md`,
  `desktop-rust.md`, `editor.md`, `list.md`, `nav.md`, `search.md`, `settings.md`,
  `settings-visual.md`, `sync.md`, `tabs.md`, and generated `GAPS.md`.

Read lease: reread the complete organization document after context compaction or foundational
replanning, and reread the complete refactoring standard before Gate C.

Lease event: the agent context was compacted during Stage 1. Production planning/editing paused,
`docs/architecture/codebase-organization.md` was reread completely through EOF, and the same
ownership/dependency foundations were reaffirmed before work resumed.

Lease event: the context was compacted again before Gate B presentation. The organization standard
was reread completely through EOF before the ledger was edited. After Gate B approval, the complete
refactoring standard was reread through EOF before Gate C cleanup or verification.

## Baseline and accounting

- Accounted base: `9ecd1f521254cc4c5101fa720249f56eece62f84`.
- Base scope: 763 production lines, 13 test lines, 2 Rust source files. Manual inspection confirms
  the heuristic correctly classified `src/lib.rs` as 760 production + 13 inline-test lines and
  `src/bin/uniffi-bindgen.rs` as 3 production lines; `Cargo.toml` is intentionally excluded.
- Historical Gate A worktree: 763 production lines, 544 test lines, 5 Rust source/test files. The
  production delta is zero. The 531-line test increase is the old-code public contract oracle,
  split by note and sync capability rather than kept in one test warehouse.
- Base `src/lib.rs` was 773 physical lines and owned every unrelated FFI concern. That mixed
  ownership—not line count by itself—was the architectural center replaced by this rewrite.

| Baseline command | Result | Exact evidence |
| --- | --- | --- |
| `cargo test -p futo-notes-ffi` before new contract tests | PASS | 1/1 library test; bindgen 0; doc tests 0. |
| `cargo test -p futo-notes-ffi` after Stage 1 contract capture | PASS | 1/1 legacy unit + 3/3 note contract + 2/2 sync contract; 6 total, 0 failed/ignored. |
| `just test-rust-full` before new contract tests | PASS | Core 171/174 (3 perf ignored) + 18 adversarial + 1 path + 2 cycle; model 22 + 6 conformance; search 8/9 (1 perf ignored); store 26; sync 46 with 27 server/SSE integration tests explicitly ignored for missing isolated server; FFI 1; Tauri 26/27 (1 OS-secret test ignored). No failures. |
| Host Swift bindgen to `/tmp/futo-notes-ffi-gate-a` | PASS | Generated Swift 3,481 lines, C header 1,025, modulemap 3; only `swiftformat` unavailable warning. |
| Host Kotlin bindgen to `/tmp/futo-notes-ffi-gate-a` | PASS | Generated Kotlin 4,143 lines; only `ktlint` unavailable warning. |
| `just build-rust-ios` | PASS | `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`; dev profile; Swift bindings + XCFramework generated. |
| First `just build-ios-native` | FAIL (environment) | Missing `node_modules/.bin/vite` in fresh worktree, matching the documented dependency condition. |
| `just install` | PASS | 297 pnpm packages installed from the locked workspace. |
| Second `just build-ios-native` | PASS | Rust/bindgen repeated, native editor bundle built, Xcode reported `** BUILD SUCCEEDED **`. |
| `just build-rust-android` | BLOCKED (environment) | No Android SDK/NDK and no `cargo-ndk`; the script exits during its SDK fallback probe before its intended diagnostic. |
| `just test-android-native` | BLOCKED (same environment) | Stops in `build-rust-android`; Gradle/JVM tests did not run. This machine also has no Java runtime. |

The Android result is deliberately not counted green. Host Kotlin generation proves the semantic
surface is bindgen-supported, but Android ABI, Kotlin compile, and JVM acceptance remain required
Gate C evidence once the Android toolchain is available.

## Frozen semantic contract and invariants

All Product-semantic exports below are frozen by name, parameters, sync/async shape, result/error
shape, record field set and field types, enum/error variants, callback methods, and observable
behavior. Rust root re-exports must continue to generate the same Swift/Kotlin semantic API.
Checked-in callers prove use but cannot authorize narrowing.

### Product objects and actions

| Object/surface | Frozen actions and results | Ownership, lifetime, and threading |
| --- | --- | --- |
| `NoteStore` | `new(notes_root) -> Arc<NoteStore>`; `bootstrap(index_dir) -> Result<NoteBootstrap, NoteError>`; `scan() -> NoteSnapshot`; `read(id) -> String`; `exists(id) -> bool`; `write(id, content) -> Result<NoteMutation, NoteError>`; `write_if_unchanged(id, expected_prev, content) -> Result<ConditionalWrite, NoteError>`; `create_if_absent(id, content) -> Result<CreateOutcome, NoteError>`; `create_note(title, folder, content) -> Result<NoteMutation, NoteError>`; `delete(id)`, `rename(old_id,new_id)`, `move_note(id,folder)`, `rename_folder(from,to)`, `delete_folder(folder)` all return complete `NoteMutation`; `create_folder(path) -> Result<String, NoteError>`; `reset() -> Result<(), NoteError>`; `search(query, Option<u32>) -> Result<Vec<SearchHit>, NoteError>`; `keyword_ready() -> bool`; `rescan()`. | One Rust object owns one `LocalNoteStore`, including its serialization gate and background search lifecycle. Constructor does no I/O. Methods are synchronous and the native actor/dispatcher keeps them off the UI thread. Rust object is `Send + Sync`; generated Swift is reference-owned and generated Kotlin is `AutoCloseable`/single-free. |
| Rule functions | `sanitize_title`, `make_id`, `split_id`, `extract_tags`, `make_preview`, `image_extensions`, `validate_title`, `make_rich_preview`, `extract_wikilinks`, with their exact current input/result types. | Stateless canonical-model projections. No shell may reimplement them. |
| `SyncClient` | `new(notes_root,server_url) -> Arc<SyncClient>`; async `connect(password) -> Result<ConnectInfo, SyncError>`; async `sync_now() -> Result<SyncSummary, SyncError>`; sync `status() -> SyncStatus`; `note_changed()`; async `start_live(self: Arc<Self>, listener: Box<dyn SyncEventListener>) -> Result<(), SyncError>`; `stop_live()`; async `disconnect() -> Result<(), SyncError>`. | One client owns immutable vault/server configuration and one `SyncSession` containing connection state, cycle gate, and live-task lifecycle. Constructor does no I/O. Async methods use UniFFI's Tokio runtime. Rust object is `Send + Sync`; generated native objects own/release the Rust pointer. |
| `SyncEventListener` | `on_synced(SyncSummary)`, `on_connected()`, `on_error(String)`, `on_stopped()`. Trait remains `Send + Sync`. | Rust owns the callback proxy while live sync uses it. Calls originate on Tokio worker threads; native implementations must marshal UI work to the main thread and remain cheap. |

### Product records, enums, and errors

| Semantic type | Frozen fields or variants |
| --- | --- |
| `NoteMetadata` | `id: String`, `title: String`, `folder: String`, `modified_ms: i64`, `preview: String`, `rich_preview: String`, `tags: Vec<String>` |
| `NoteSnapshot` | `notes: Vec<NoteMetadata>`, `folders: Vec<String>` |
| `NoteRename` | `from: String`, `to: String` |
| `NoteMutation` | `upserted: Vec<NoteMetadata>`, `removed: Vec<String>`, `renamed: Vec<NoteRename>`, `warnings: Vec<String>` |
| `NoteBootstrap` | `snapshot: NoteSnapshot`, `seeded: u32`, `migrated: u32`, `warnings: Vec<String>` |
| `NoteIdParts` | `folder: String`, `title: String` |
| `ConditionalWrite` | `outcome: FlushOutcome`, `mutation: Option<NoteMutation>` |
| `TitleIssue` | `kind: String`, `message: String` |
| `SearchHit` | `note_id: String`, `score: f64`, `source: String` |
| `FlushOutcome` | `Wrote`, `SkippedMissing`, `SkippedChanged` |
| `CreateOutcome` | `Created`, `Existed` |
| `NoteError` | `Io(String)` with current display text |
| `ConnectInfo` | `user_id: String`, `collection_id: String`, `auth_mode: String` |
| `SyncFailure` | `filename: String`, `kind: String`, `status_code: Option<u16>` |
| `SyncSummary` | `uploaded: u32`, `downloaded: u32`, `deleted: u32`, `conflicts: u32`, `local_writes_applied: u32`, `failures: Vec<SyncFailure>`, `failure_message: Option<String>` |
| `SyncStatus` | `connected: bool`, `server_url: Option<String>`, `user_id: Option<String>`, `collection_id: Option<String>`, `max_version: u64`, `object_count: u32` |
| `SyncError` | `Http(String)`, `Crypto(String)`, `Io(String)`, `Auth(String)`, `CollectionGone(String)`, `NotConnected`, with current display prefixes/text |

### Frozen behavioral invariants

1. FFI remains a thin projection: note rules/workflows/search/sync semantics stay owned by the
   model/store/sync crates and are never mirrored in FFI or native shells.
2. Filenames are titles without cosmetic transformation; note IDs and path safety remain canonical
   lower-layer decisions.
3. Every mutation is returned only after the owning store commits it, and contains complete
   upserts, removals, collision-resolved renames/backlink rewrites, and warnings.
4. Conditional flush never resurrects a missing note or overwrites content changed since the
   expected read. `create_if_absent` never overwrites a concurrent winner.
5. Bootstrap returns the initial snapshot even when best-effort search startup fails; search owns
   one background index lifecycle and never blocks native shell rendering.
6. Sync is push-first. Dirty local bytes are uploaded or conflict-resolved before pull can write.
7. `local_writes_applied`, failures, and the canonical failure message remain lower-computed shell
   decisions; shells do not re-derive them from other counters.
8. `status()` is synchronous/nonblocking; `note_changed()` and `stop_live()` are safe when idle;
   `start_live()` requires a connected session; disconnect stops live work and preserves only the
   allowed ancestry needed for safe reconnect.
9. `CollectionGone` remains distinct so shells can reconnect to the surviving canonical vault.
10. Listener callbacks remain worker-thread callbacks and cannot acquire blocking UI or session
    work.
11. Panics must unwind through UniFFI's catch boundary: iOS remains on `dev`; Android remains on
    `release-ffi` with `panic = "unwind"`; plain release is prohibited.
12. Swift/Kotlin source layout, UniFFI checksums/symbols, headers, libraries, XCFrameworks, and JNI
    files are regenerable artifacts. Semantic compatibility is required; byte/layout identity is
    not.

## Surface classification

| Surface | Kind | Consumers | Required behavior | Final owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| Every `NoteStore` constructor/method listed above | Product semantic | Swift `NoteVault`/`NotesStore`; Kotlin `NotesStore`; some capabilities currently used by one shell only | Exact semantic action, signature, error/result, object identity and lifecycle | `notes/store.rs` | Preserve without narrowing. |
| Every rule function listed above | Product semantic | Swift/Kotlin editors and image pickers; exported unused functions remain supported | Exact name, types, and canonical-model result | `notes/rules.rs` | Preserve; delegate only. |
| Every note/search record field and note enum/error variant listed above | Product semantic | Generated Swift/Kotlin API; native list/editor/search code; external API lower bound extends beyond checked-in callers | Exact full shape and meanings | `notes/contract.rs`, except rule-result records in `notes/rules.rs` | Preserve every field/variant. |
| Every `SyncClient` constructor/method listed above | Product semantic | Swift/Kotlin `SyncManager`; `status()` currently has no checked-in call but remains shipped | Exact sync/async shape, lifecycle and errors | `sync/client.rs` | Preserve without narrowing. |
| Every sync record field and `SyncError` variant listed above | Product semantic | Generated bindings; Swift/Kotlin sync managers and Android JVM tests | Exact full shape, counts, messages, options and error distinction | `sync/contract.rs` | Preserve every field/variant. |
| All four `SyncEventListener` methods and `Send + Sync` bound | Product semantic | Swift/Kotlin live listeners | Exact callback shape, ownership and worker-thread delivery | `sync/events.rs` | Preserve. |
| `From<futo_notes_store::...>` and `From<futo_notes_sync::...>` mappings | Private mechanism | FFI object/action implementations | Losslessly populate the frozen FFI shapes | Owning `notes/contract.rs` / `sync/contract.rs` | Rebuild as focused pure mappings; not independently shipped. |
| `From<SyncErrorKind>`, `From<FlushOutcome>`, `From<CreateOutcome>` | Private mechanism | FFI error/outcome projection | Exhaustive one-to-one variant translation | Owning contract module | Preserve mechanism semantics; private module placement may change. |
| `no_progress`, `no_pre_write` | Private mechanism | `SyncClient` projection | Native has no watcher/progress hook; calls remain inert and explicit | `sync/client.rs` | Keep local to sole consumer. |
| `FfiListener` adapter and `SyncSessionListener` impl | Private mechanism | `SyncClient::start_live` | Forward all four callbacks and convert the summary once | `sync/events.rs` | Rebuild focused; keep private. |
| Private fields of `NoteStore` and `SyncClient` | Private mechanism | Owning object methods only | One lower-layer state/lifecycle owner per exported object | `notes/store.rs` / `sync/client.rs` | Preserve ownership; field names/layout are not contractual. |
| `uniffi::setup_scaffolding!()` | Private build mechanism | UniFFI proc-macro exports | Exactly one crate-root scaffolding invocation | `src/lib.rs` | Preserve. |
| `src/bin/uniffi-bindgen.rs` | Private build mechanism | iOS/Android generation scripts | Invoke UniFFI bindgen CLI | Same path | Reuse unchanged; already focused/conforming. |
| Direct `futo-notes-core` Cargo dependency | Private dependency declaration | No source/test/build consumer; `rg` finds only the manifest row | None beyond transitive collaborator use through store/sync | `Cargo.toml` | Remove as genuinely unused direct dependency after implementation. No cross-crate change. |
| Generated Swift source/protocols/records/errors | Generated artifact | Xcode native compile | Must regenerate the frozen semantic API and compile; byte-for-byte layout is unsupported | `apps/ios/Sources/Generated` (ignored) | Regenerate, never hand-edit or freeze generated bytes. |
| Generated Kotlin/JNA source | Generated artifact | Gradle/native compile and Android JVM tests | Must regenerate the frozen semantic API and compile | Android `uniffi/` tree (ignored) | Regenerate, never hand-edit. |
| C header/modulemap, static libraries, XCFramework | Generated artifact | Xcode linker | Correct generated symbols for current semantic API and dev-profile build | iOS generated/build paths (ignored) | Rebuild. |
| Android `.so` and `jniLibs` | Generated artifact | Android linker/JNA | Correct ABI libraries built with `release-ffi`/unwind | Android generated/build paths (ignored) | Rebuild when toolchain is available. |
| UniFFI checksums/symbol names and generated converter layout | Generated artifact | Generated sources/binaries of the same run | Internally consistent for the regenerated API | UniFFI generator | May change; not a semantic compatibility surface. |

## Semantic change proposals

No semantic deletion, signature change, field reduction, callback reduction, or result-data
reduction is proposed. Any future proposal requires its own row and separate explicit approval.

| Surface change | Product/spec authority | Architecture necessity | Reconstructible? | Safety/lifecycle impact | Consumer migration | User decision |
| --- | --- | --- | --- | --- | --- | --- |
| None | N/A | The structural rewrite proceeds with a frozen semantic API. | N/A | None | None | N/A |

## Legacy-test promise ledger

| Legacy file:test | Plain-English promise | Evidence/source | Classification | New guarding test/scenario | Baseline status/count | Final status/count | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `src/lib.rs::tests::image_extensions_expose_the_canonical_vault_rule` | The public FFI image-extension list is exactly the canonical model allowlist, with no native-only drift. | Root M6/M7; editor image spec | Fast | `tests/note_contract.rs::deterministic_rules_are_thin_projections_of_the_canonical_model` | PASS 1/1 | PASS at Gate B; replacement 1/1, legacy deleted | Promise remains guarded through the public note contract. |
| `SyncManagerOutcomeTest::cleanCycleReportsSuccessAndClearsPreviousError` | A clean generated `SyncSummary` reports success and clears a prior Android sync error. | `docs/spec/sync.md`; generated record consumer | Acceptance | Preserve exact Android JVM scenario | Source census 1; execution initially blocked | PASS 1/1 | Executed as `cleanCycleReportsSyncCompleteAndClearsError`. |
| `SyncManagerOutcomeTest::failureMessageIsRenderedVerbatim` | Android renders the canonical lower-computed `failureMessage` verbatim instead of inventing shell text. | Sync spec; M6 | Acceptance | Preserve exact Android JVM scenario | Source census 1; execution initially blocked | PASS 1/1 | Executed as `failingCycleRoutesRustMessageToErrorLineVerbatim`; also pins `SyncFailure` and every current `SyncSummary` constructor field. |
| `SyncManagerReloadGateTest::pushSideMergeReloadsEvenWithoutDownloadCounts` | `localWritesApplied > 0` reloads the native note/editor projection even when download/delete counters are zero. | Sync F2 invariant | Acceptance | Preserve exact Android JVM scenario | Source census 1; execution initially blocked | PASS 1/1 | Executed as `pushSideMergeReloadsEvenWithNoDownloadsOrDeletes`. |
| `SyncManagerReloadGateTest::noOpOrPureUploadDoesNotReloadLocalState` | A no-op or pure upload does not reload local note state. | Sync outcome semantics | Acceptance | Preserve exact Android JVM scenario | Source census 1; execution initially blocked | PASS 1/1 | Executed as `noOpCycleDoesNotReload`. |
| `SyncManagerReloadGateTest::downloadsAndDeletesReloadLocalState` | Downloads and deletes trigger native state reload. | Sync outcome semantics | Acceptance | Preserve exact Android JVM scenario | Source census 1; execution initially blocked | PASS 1/1 | Executed as `peerDownloadsAndDeletesStillReload`. |

Ledger totals at Gate A: 6 legacy promises translated; 1 Fast, 5 Acceptance, 0 Core, 0
Obsolete, 0 Follow-up. Five additional old-code public-contract tests were added and are green:

| New Stage 1 guard | What it proves against current main | Status |
| --- | --- | --- |
| `note_contract::deterministic_rules_are_thin_projections_of_the_canonical_model` | All nine free rule actions delegate to canonical model results and keep result records. | PASS |
| `note_contract::note_store_projects_complete_workflow_results` | Constructor, bootstrap, every note/folder/write safety workflow, complete mutations, search calls, scan and reset work through the public FFI object. | PASS |
| `note_contract::note_records_errors_and_threading_keep_the_full_semantic_shape` | Every note/search field and variant remains constructible/destructurable; display text and `Send + Sync` remain. | PASS |
| `sync_contract::sync_records_errors_callbacks_and_threading_keep_the_full_semantic_shape` | Every sync field/error/callback signature and `Send + Sync` bound remains. | PASS |
| `sync_contract::disconnected_sync_client_has_stable_lifecycle_semantics` | Constructor/status/no-op notifications/stop, `NotConnected` cycle/live behavior, callback ownership, and disconnect are stable. | PASS |

## Invariant map

| Invariant | Source | Old guard | Final guard | Status |
| --- | --- | --- | --- | --- |
| Constructors perform no I/O and exported objects own one lower-layer lifecycle. | Current shipped docs/API; organization state-owner rule | Native wrappers; collaborator constructors | Note/sync public contract tests + native compile | Captured |
| Every frozen record field, enum/error variant, callback and action survives, even if unused by current callers. | Guided semantic-freeze rule; user instruction | Generated bindings/call sites only, incomplete | Shape tests + regenerated Swift/Kotlin + native compile | Captured |
| Note rules are canonical model projections, not FFI/native copies. | Root M6/M7; app/editor specs | Model 22 + conformance 6; old image-only FFI test | Full rule projection test + unchanged lower suites | Captured |
| Filename is title; path/title safety stays lower-owned. | Root M2/M6; app/list specs | Core title/path tests; model conformance | Delegation test + lower suites | Captured |
| Note metadata/snapshot/mutation/bootstrap projections preserve all data. | List/search specs; complete-mutation rule | Store 26; native consumer code | Note records + workflow contract tests + native builds | Captured |
| Conditional write never resurrects missing or overwrites changed content. | Editor saving spec; root data-safety rules | Store `conditional_flush...` | Public workflow test + store test | Captured |
| Create-if-absent never clobbers a concurrent/existing winner. | Editor peer-delete flow | Store create-if-absent tests | Public workflow test + store tests | Captured |
| Rename/move/folder workflows return collision/backlink-aware complete mutations. | List/editor specs; root M6 workflow ownership | Store rename/folder tests | Public workflow test + store tests | Captured |
| Bootstrap does not gate shell render on search and search remains store-owned/background. | Root M1/M5; search spec | Store bootstrap/search tests | Public bootstrap/search calls + store tests + native compile | Captured |
| Reset removes vault contents but retains the root; shells must reset their caches separately. | Root M4; app spec | Store reset test | Public workflow reset assertion + store test | Captured |
| Sync is push-first and preserves conflict/merge safety. | Root sync checklist; sync spec F1 | Sync 46 + ignored isolated-server F1 test | Unchanged sync suite; FFI maps only; isolated integration at Gate C when available | Captured; real-server guard environment-dependent |
| Sync summary preserves counts, local writes, failures, and canonical message. | Sync spec F2; Android tests | Sync `combined_summary...` and failure-message tests | Sync record test + Android 5 JVM tests + sync suite | Captured; Android execution blocked |
| `status` never blocks and idle lifecycle calls are safe. | Sync spec; current API docs | Sync session status/stop tests | Public disconnected lifecycle test + sync tests | Captured |
| Live callbacks forward all events from worker threads; UI marshaling stays native-owned. | Current shipped callback docs; iOS/Android listeners | Native implementation review | Callback shape test + native compile + comment census | Captured |
| Disconnect stops live state and preserves safe ancestry only. | Sync spec reconnect rules | Sync checkpoint/session tests | Public disconnect call + unchanged sync tests | Captured |
| `CollectionGone` remains a distinct recoverable error. | Sync spec; native managers | Sync integration tests ignored without server; consumer matches | Shape/error test + native compile + isolated integration when available | Captured; server execution pending |
| UniFFI panic boundary uses unwind-compatible native profiles. | Root Rust critical rule; build scripts/root Cargo | Current iOS build green; Android unavailable | iOS dev + Android release-ffi builds and config audit | Captured; Android execution blocked |
| Generated layouts may change while semantic Swift/Kotlin API remains. | Guided generated-artifact rule; root M8/M9 | Current host bindgen + iOS build | Regenerate both, inspect API, compile both shells | Captured; Android compile blocked |

## Responsibility inventory

| Current path | Responsibilities | Owner | Public/private | State/effects | Problem | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `crates/futo-notes-ffi/Cargo.toml` (30 lines) | FFI crate types, bindgen binary, UniFFI/Tokio/lower-crate dependencies | FFI boundary | Private build config | Build/link/profile participation | Narrative still describes a spike; direct core dependency has no consumer | Update ownership text; remove only proven unused direct core dependency. |
| `src/lib.rs` (773 physical; 760 production + 13 test) | Crate docs, scaffolding, all note records/mappings/object methods/rules/search, all sync records/errors/mappings/callback adapter/object methods, inline test | FFI boundary | Mixed public/private | Owns two independent stateful object lifecycles plus many stateless projections | Facade warehouse; root cannot explain dependency direction; unrelated capabilities and narration are interleaved | Delete center after replacement exists in approved owners; root becomes facade only. |
| `src/bin/uniffi-bindgen.rs` (3) | UniFFI CLI entry | FFI build boundary | Private executable | Process entry | None; already one responsibility | Reuse unchanged. |
| Inline `src/lib.rs` test (13) | Image allowlist projection parity | Note rules boundary | Test | Stateless | Only one FFI promise; coupled to center placement | Replace with already-green public note contract row, then delete duplicate. |
| `tests/note_contract.rs` (341) | Public note/rule/store/record acceptance oracle | Assembled note FFI boundary | Test | Temp vault/search side effects | None; cohesive external note capability, not a private-seam mirror | Keep as Gate A oracle; refine only if target evidence demands it. |
| `tests/sync_contract.rs` (155) | Public sync record/error/callback/lifecycle oracle | Assembled sync FFI boundary | Test | Tokio lifecycle; temp root | None; cohesive external sync capability | Keep. |
| `tests/support/mod.rs` (35) | Hand-rolled unique temp tree/path helper shared by two public suites | Nearest common test owner | Private test support | Filesystem cleanup | None; real reuse and repository-conforming temp policy | Keep. |
| `scripts/build-rust-ios.sh` (65) | Build 3 Apple targets with dev profile; generate Swift; assemble XCFramework | Native binding pipeline | Private operational config | Generated filesystem outputs | None in rewrite design | Do not edit; verify. |
| `scripts/build-rust-android.sh` (79) | Build 3 Android ABIs with `release-ffi`; generate Kotlin/JNI | Native binding pipeline | Private operational config | Generated filesystem outputs | Baseline fallback exits silently when SDK directory is absent, but fixing diagnostics is not required to preserve the FFI contract | Out of implementation scope; record only. Verify when toolchain exists. |
| `apps/ios/Sources/NotesStore.swift` (601) | Actor-based native projection/cache over `NoteStore`; consumes complete mutations/search | iOS note shell | Product consumer | Actor/UI state and I/O scheduling | No FFI rewrite problem | Read-only acceptance consumer unless regenerated API forces a semantic-preserving compile correction. |
| `apps/ios/Sources/SyncManager.swift` (313) | Native lifecycle/UI projection over `SyncClient`, callbacks, errors, summaries | iOS sync shell | Product consumer | Main-actor state, keychain, live lifecycle | No FFI rewrite problem | Same. |
| iOS rule consumers: `EditorImages.swift` (281), `NoteEditorView.swift` (719), `NoteListView.swift` (707) | Image allowlist and title/id validation/actions | iOS rule consumer | Product consumer | UI | No FFI rewrite problem | Same. |
| `apps/android/.../NotesStore.kt` (445) | Dispatcher-based native projection/cache over `NoteStore` | Android note shell | Product consumer | Coroutine/UI state and I/O scheduling | Current use omits some shipped FFI methods; that is not deletion evidence | Read-only acceptance consumer unless compile correction is required. |
| `apps/android/.../SyncManager.kt` (323) | Native projection over `SyncClient` and callbacks | Android sync shell | Product consumer | Coroutine/state/live lifecycle | Same | Same. |
| Android rule consumers: `ImagePicker.kt` (156), `NoteEditorScreen.kt` (610), `NewFolderDialog.kt` (97) | Image/title/id actions | Android rule consumer | Product consumer | UI | None | Same. |
| Android sync JVM tests (60 + 52) | Summary/failure/reload acceptance | Android sync consumer | Test | Pure generated-record consumption | Cannot run without Android toolchain on this machine | Preserve and run at Gate C. |
| `apps/ios/project.yml` (103), Android `build.gradle.kts` (174), `proguard-rules.pro` (28), root Cargo profiles | Link generated bindings, keep callbacks/JNA, preserve unwind-compatible native profiles | Native build boundary | Private config with safety constraints | Build/package | No planned semantic change | Preserve; audit and verify. |
| Generated Swift/Kotlin/header/modulemap/XCFramework/JNI/.so outputs | Language/API and linker artifacts | Generator | Generated artifact | Recreated by scripts | Ignored and unsupported as hand-maintained layout | Regenerate only; never edit or commit. |

## State and lifecycle map

| Responsibility | Mutable/in-flight state | Lifecycle | Stateless operation | Intended owner/module |
| --- | --- | --- | --- | --- |
| Local note workflows + search | One wrapped `LocalNoteStore` owns workflow gate, vault root, search config/engine/background indexer | `NoteStore::new` creates owner without I/O; bootstrap starts best-effort search; object release drops it | Record conversion only | `notes/store.rs` state; `notes/contract.rs` mappings |
| Note rules | None | None | All nine model projections and rule-result construction | `notes/rules.rs` |
| Sync session | `SyncClient` owns notes root, server URL, and one `SyncSession`; the collaborator owns optional connection, cycle gate and live task | connect/replace; sync cycle; live start/replace/stop; disconnect/demote; object release | Record/error conversion and no-op hooks | `sync/client.rs` state; `sync/contract.rs` mappings |
| Foreign live listener | Arc-owned callback proxy retained by session/live task | Created for `start_live`, released when lower session drops it | Four event forwards + summary conversion | `sync/events.rs` |
| Crate facade | No state | Compile/link setup only | Module declarations, deliberate root re-exports, one scaffolding macro | `src/lib.rs` |
| Native Swift/Kotlin shells | Their own actor/coroutine/UI state; never FFI ambient state | Existing app lifecycle | Consume results and marshal callbacks | Existing native owners, outside rewrite implementation |

## Gate A target tree

This tree is the proposed binding first-compile constraint. After approval, the directories and
module facades are created first and substantial behavior is implemented only inside these owners.
No renamed copy of old `lib.rs`, transitional production monolith, compatibility forwarding layer,
or cross-capability translated-test file is permitted.

| Target path | Responsibility | Dependencies | State/lifecycle | Expected size/risk | Implementation provenance |
| --- | --- | --- | --- | --- | --- |
| `src/lib.rs` | Crate purpose, `mod notes`, `mod sync`, deliberate root `pub use`, exactly one `setup_scaffolding!` | Child facades + UniFFI | None | ~15–25 lines; low | Reuse only scaffolding invocation; reconstruct facade. |
| `src/notes/mod.rs` | Private capability facade re-exported deliberately at crate root | `contract`, `rules`, `store` | None | ~10–20; low | New module boundary; no legacy center move. |
| `src/notes/contract.rs` | Store/search semantic records, outcomes, `NoteError`, and pure exhaustive lower-store → FFI mappings | `futo-notes-store`, UniFFI, thiserror | None | ~150–190; medium compatibility risk | Preserve exact current definitions/mappings; each unit already focused, but assemble by contract ownership rather than copy the old region wholesale. |
| `src/notes/rules.rs` | Nine free canonical-model projections plus `NoteIdParts` and `TitleIssue` result records | `futo-notes-model`, UniFFI | None | ~90–120; low | Existing function bodies are focused/conforming one-step delegations and may be reused with module-level provenance. |
| `src/notes/store.rs` | `NoteStore` object, constructor, note/folder/search methods, bootstrap/reset and conversion orchestration | sibling note contract + `futo-notes-store`; standard path/Arc | One `LocalNoteStore` owner | ~210–260; high behavior/compatibility risk | Rebuild method families from frozen actions; individual legacy calls are focused and may be reused, but the old center is not moved. Search remains here because store owns its lifecycle. |
| `src/sync/mod.rs` | Private sync capability facade re-exported at crate root | `client`, `contract`, `events` | None | ~10–20; low | New module boundary. |
| `src/sync/contract.rs` | Sync records, failures/status/summary, `SyncError`, and pure exhaustive lower-sync → FFI mappings | `futo-notes-sync`, UniFFI, thiserror | None | ~140–180; high compatibility risk | Preserve exact definitions/mappings. This is a real external-contract owner, not a DTO dump: all translation and error normalization live here. |
| `src/sync/events.rs` | Public callback interface and private lower-session listener adapter | sibling contract + `futo-notes-sync` | Arc callback lifetime only, no ambient state | ~60–85; high threading risk | Focused legacy adapter/trait semantics may be reused; comments retained only for worker-thread/lifecycle constraints. |
| `src/sync/client.rs` | `SyncClient` state owner and connect/cycle/status/change/live/disconnect orchestration; local inert hooks | sibling contract/events + `futo-notes-sync`; path/Arc | One `SyncSession` owner | ~145–185; high data-safety risk | Rebuild directly from frozen actions; individual thin calls reusable with provenance. Push-first stays delegated to collaborator. |
| `src/bin/uniffi-bindgen.rs` | Bindgen CLI entry | UniFFI CLI | Process only | 3; low | Reuse unchanged. |
| `tests/note_contract.rs` | Assembled public note/rule/object contract | Crate public root API + canonical model comparison | Temp vault/index | 341 now; target no growth without a distinct boundary promise | Stage 1 old-code oracle; keep capability-cohesive. |
| `tests/sync_contract.rs` | Assembled public sync records/errors/callback/lifecycle contract | Crate public root API | Tokio + temp root | 155 now | Stage 1 old-code oracle; keep capability-cohesive. |
| `tests/support/mod.rs` | Shared handcrafted temp-tree utility | std only | Test filesystem cleanup | 35 | New, already conforming and shared by two independent suites. |
| `Cargo.toml` | Accurate FFI boundary/build dependencies | UniFFI/Tokio/model/store/sync/thiserror | Build config | Small | Preserve crate types/features; remove unused direct core edge only. |

Dependency direction is one-way: crate root → capability facades → stateful object or stateless
contract/rule/event modules → owning lower crates. Sibling capability modules do not import each
other. Native consumers see only the deliberate crate-root semantic facade. No new ambient state,
factory, accessor, or domain logic is introduced.

## Gate B actual architecture audit

The first green replacement already matches the approved Gate A tree. There is no deferred known
architecture and no proposed emergent refinement.

| Approved path | Actual lines | Actual responsibility | Match |
| --- | ---: | --- | --- |
| `src/lib.rs` | 16 | Crate facade, deliberate root re-exports, single scaffolding invocation | Exact |
| `src/notes/mod.rs` | 13 | Note capability facade | Exact |
| `src/notes/contract.rs` | 153 | Note/store/search records, errors, outcomes and pure mappings | Exact |
| `src/notes/rules.rs` | 69 | Nine canonical model projections and their result records | Exact |
| `src/notes/store.rs` | 154 | One `LocalNoteStore` owner and all note/folder/search actions | Exact |
| `src/sync/mod.rs` | 9 | Sync capability facade | Exact |
| `src/sync/contract.rs` | 90 | Sync records, errors and pure lower-sync mappings | Exact |
| `src/sync/events.rs` | 42 | Callback contract and private listener bridge | Exact |
| `src/sync/client.rs` | 101 | One `SyncSession` owner and all sync lifecycle actions | Exact |
| `src/bin/uniffi-bindgen.rs` | 3 | Bindgen CLI | Exact; unchanged |
| `tests/note_contract.rs` | 341 | Public note/rule/store contract | Exact |
| `tests/sync_contract.rs` | 155 | Public sync contract | Exact |
| `tests/support/mod.rs` | 35 | Shared hand-rolled temp-tree support | Exact |

Gate B evidence keys:

- **B1 — Structure:** the old 773-line center is gone; no transitional warehouse, compatibility
  forwarding module, duplicated domain logic, or orphan old structure remains.
- **B2 — State:** the only durable FFI state owners are `NoteStore(LocalNoteStore)` and
  `SyncClient(SyncSession + immutable configuration)`; other modules are stateless except the
  callback Arc lifetime.
- **B3 — Public compatibility:** all five public contract tests pass. Host Swift and Kotlin
  generation pass. The old and new generated Swift files contain the same 40 exported
  function/method/constructor/callback checksum symbol names; checksum values changed with source
  documentation/layout and are classified generated, not semantic.
- **B4 — Native acceptance:** `just build-ios-native` passes after the rewrite for all Rust Apple
  targets, regenerated Swift/XCFramework, editor bundle, and Xcode compile. Android remains blocked
  by the previously recorded missing toolchain.
- **B5 — Dependency cleanup:** `cargo tree -p futo-notes-ffi --depth 1` no longer contains the
  unused direct `futo-notes-core` edge; model/store/sync remain the only owning collaborators.
- **B6 — Tests:** default FFI test execution is non-vacuous: 3 note + 2 sync tests, 5/5 green,
  with the duplicate inline legacy test deleted only after its promise was covered.
- **B7 — Accounting:** production is 763 → 650 lines (-113, -14.8%). The largest files are the
  cohesive note store (154), note contract (153), sync client (101), and sync contract (90).
- **B8 — Scope:** no model/core/store/sync/native source file was modified; only FFI source/tests,
  its manifest/lock entry, direct binding-script comments, one stale behavioral-spec reference,
  and this ledger changed.

Emergent Gate B findings: none. The implementation needs no additional extraction, merge, rename,
state accessor, test relocation, or target-tree deviation before final cleanup and verification.

Gate C whole-scope audit found one documentation inconsistency rather than a missing semantic
capability: `docs/spec/editor.md` still named an obsolete separate `NoteStore.relink` call.
Current-main FFI never exported that action; current native callers use `rename`/`move_note`, and
`LocalNoteStore::rename` performs the move plus backlink rewrites under one workflow lock. The spec
was corrected to describe that current product contract. No FFI action was added, removed, or
changed. The iOS/Android binding-script comments were also updated from the historical “single
facade” wording to the actual organized notes/sync projection architecture.

The terminal diff audit also found one comment-census omission: the private `no_progress` and
`no_pre_write` hooks were correctly retained but their platform rationale had been deleted. A
concise source comment now records that native shells have neither watcher suppression nor
per-phase progress consumers. This is a private-mechanism clarification with no behavior change.

## Compatibility and generated artifacts

- Shipped semantic UniFFI capabilities are frozen by default.
- All public Rust items remain deliberately re-exported at the crate root, so Rust callers and
  UniFFI see the same names despite private module reorganization.
- No native consumer migration is planned because no signature, record, field, enum/error,
  callback, or result change is proposed. A compile-only adjustment is allowed only if generator
  output requires a semantic-preserving spelling change; it must be recorded separately.
- Current use is explicitly not removal authority: Android does not call `create_if_absent` or
  `rename_folder`; neither shell calls `status`; several free rule functions have no checked-in
  native caller. All remain Product semantic.
- Private conversion impl placement, private field layout, aliases for lower crates, module paths,
  section banners, and the unused direct `futo-notes-core` dependency are not compatibility
  surfaces.
- Generated Swift/Kotlin bindings, checksums, binaries, and JNI/XCFramework outputs are generated
  artifacts, not independent semantic contracts unless current-main evidence proves otherwise.
- Generated outputs will be regenerated from the preserved semantic API, never hand-edited.
- The iOS dev profile and Android `release-ffi` profile remain mandatory because UniFFI requires
  unwind-safe panic handling.
- Generated source/binary directories remain ignored and must not appear in the final diff. Gate C
  compares the regenerated semantic API (objects/actions/records/fields/errors/callbacks), then
  compiles consumers; it does not demand byte-for-byte converter/checksum identity.

## Comment disposition and census

Gate A policy was to keep only non-obvious safety, ordering, threading, lifecycle, wire, or caller
constraints; move product requirements to specs and historical rationale here; delete narration.
The family policy was resolved by the completed individual census below.

| Current comment family | Gate A disposition | Reason |
| --- | --- | --- |
| Crate-level history (`single facade`, relocation, old spike) and large section banners | Delete/reduce to a one-sentence crate purpose | Target tree carries ownership; historical placement is not runtime intent. |
| Simple record/method narration (`read`, `exists`, `write`, `move`, `search hit`) | Delete when signature/name is sufficient | Restates code or product behavior. |
| Tags/rich-preview/title-issue/failure-kind/status-code wire meanings | Keep only the compact wire/caller constraint | Native callers cannot infer canonical string/value conventions from types. |
| Conditional write and create-if-absent TOCTOU/no-clobber rationale | Keep concise safety/ordering rationale | Non-obvious data-integrity contract and accepted residual syscall window. |
| Folder delete partial-failure/collision ordering | Keep only non-obvious safety/order; product behavior remains in spec | Order and partial-effect risk are not obvious from method name. |
| Search background/best-effort bootstrap comments | Keep concise lifecycle constraint at orchestration point | Prevents M1/M5 gated render regressions. |
| Push-first cycle, short session-lock duration, and cursor ordering | Keep concise safety/order/lifecycle rationale | CRITICAL data safety and nonblocking status behavior. |
| `CollectionGone` recovery distinction | Keep concise wire/caller recovery constraint | Explains why a separate error variant exists. |
| Listener worker-thread/main-thread marshalling and safe callback behavior | Keep | Thread/lifecycle constraint not carried by trait signature. |
| `From<SyncSummary>` comment justifying dropped lower-engine fields because native does not render them | Delete that rationale | Current callers are only a lower bound. Preserve the frozen FFI fields, but do not use lack of rendering to justify semantic reduction. |
| Build-script/Cargo comments explaining `dev`/`release-ffi`, unwind, symbols, generated phases | Preserve in unchanged operational owners | Safety and operational phase comments are required and already well placed. |

### Completed changed-production comment census

| Final location | Comment | Disposition and reason |
| --- | --- | --- |
| `src/lib.rs:1` | Crate is the native UniFFI projection | Keep: concise boundary purpose. |
| `notes/rules.rs:9` | `TitleIssue.kind` is a stable snake_case native identifier | Keep: wire/caller constraint not expressed by `String`. |
| `notes/store.rs:18` | Constructor performs no I/O | Keep: lifecycle/render constraint. |
| `notes/store.rs:26` | Search startup is best effort and cannot gate snapshot | Keep: M1/M5 lifecycle constraint. |
| `notes/store.rs:53-56` | Conditional flush no-resurrection/no-clobber and accepted non-CAS window | Keep: data-safety rationale and external filesystem constraint. |
| `notes/store.rs:72` | Create-if-absent uses no-replace semantics against live-sync races | Keep: concurrency/safety rationale. |
| `notes/store.rs:128` | Folder workflow moves/rewrites before tree removal | Keep: non-obvious ordering constraint. |
| `sync/contract.rs:16` | `local_writes_applied` means local tree writes | Keep: caller decision encoded in an otherwise ambiguous counter. |
| `sync/contract.rs:18` | Failure kinds are canonical engine wire kinds | Keep: wire constraint. |
| `sync/contract.rs:20` | Failure message is canonical and absent on clean cycles | Keep: cross-shell caller constraint. |
| `sync/client.rs:8` | Native sync has no watcher-suppression or phase-progress consumer | Keep: platform/caller constraint explaining deliberately inert hooks. |
| `sync/client.rs:20` | Constructor performs no I/O | Keep: lifecycle constraint. |
| `sync/client.rs:42-44` | Push-first ordering and short state-lock lifetime | Keep: CRITICAL safety/order/nonblocking constraint. |
| `sync/client.rs:93-94` | Disconnect preserves verified ancestry only | Keep: non-obvious reconnect/data-safety lifecycle. |
| `sync/events.rs:7-8` | Callbacks run on Tokio workers and must marshal UI work | Keep: threading/caller constraint. |
| `Cargo.toml:8` | Three crate types and their consumers | Keep: build-output mapping is not obvious from the array. |
| `Cargo.toml:15` | Dependencies are a thin projection over owning crates | Keep: dependency-direction constraint. |
| `Cargo.toml:17-19` | UniFFI features enable Tokio/bindgen and proc-macro scaffolding | Keep unchanged: build mechanism constraint. |

Deleted comments comprise the old history/relocation narrative, section banners, obvious
method/record narration, duplicated product specification prose, and the caller-based rationale for
dropping lower sync-engine fields. No commented-out code remains.

## Test placement disposition

- Assembled UniFFI behavior belongs at the public projection boundary.
- Stable pure mapping behavior may be tested beside its capability owner.
- Canonical model/store/sync promises remain guarded by their owning crates, with FFI delegation
  evidence only where that catches a distinct projection failure.
- No private factory or translated-test warehouse will be introduced for test access.
- `tests/note_contract.rs` and `tests/sync_contract.rs` remain separate capability-level public
  suites. They may not be merged into a generic compatibility warehouse.
- The one inline image-extension test is removed only after its promise remains covered by the
  public note suite; no legacy private seam is retained merely for tests.
- Pure conversion tests may be added beside `notes/contract.rs` or `sync/contract.rs` only for a
  distinct mapping failure that cannot be observed economically through the assembled public API.
- Existing Android outcome/reload tests stay in the native consumer layer; duplicating their UI
  decision logic inside FFI would violate ownership.

## Requirement-to-evidence matrix

Every applicable normative rule is imported below. Gate B evidence is recorded by the actual
architecture audit, comment census, and evidence index. Gate C evidence is recorded in the final
verification log; rows that require the unavailable Android toolchain remain explicitly blocked.

### Guided rewrite and explicit task requirements

| Source + requirement | Applies? / N/A reason | Gate A design evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Use current local main as the sole code source; do not inspect or reuse prior attempts. | Applies | Base `9ecd1f5`; inventory derived only from this worktree/current-main authorities. | Diff/provenance audit contains no prior-tree source. | Final provenance statement. | Gate C verified |
| Create and continuously maintain the durable ledger. | Applies | This file contains base, scope, reads, baselines, promises, tree, dispositions and matrix. | Update with actual implementation and Gate B findings. | Complete accounting/evidence. | Gate C verified |
| Establish black-box coverage against old code before rewrite. | Applies | Five public contract tests added and green against unchanged production. | Same tests green after replacement. | Full suites green. | Gate C verified |
| Translate every legacy test before disposition. | Applies | Six individual promises and exact dispositions recorded. | Reconcile any test changes. | Totals sum with no orphan test. | Gate C verified |
| Classify Product semantic, Private mechanism and Generated artifact separately. | Applies | Complete classification table above. | Actual files match classification. | Final inventory reconciled. | Gate C verified |
| Freeze exported/product actions, records, every field, errors, callbacks and results by default; callers are only a lower bound. | Applies | Complete frozen action/type tables; unused actions explicitly retained. | Generated semantic API diff has no narrowing. | Swift/Kotlin inspection + native builds. | Gate C verified |
| Any semantic deletion/signature/data reduction requires separate product/spec authority and explicit approval. | Applies | Proposal table contains none; target tree approval cannot authorize pruning. | Stop and add one decision row if discovered. | Zero unapproved change. | Gate C verified |
| Gate A must bind explicit target ownership tree and responsibilities before production implementation. | Applies | Full target tree/responsibilities/dependencies/sizes/provenance above. | Actual-vs-approved diff is empty. | Final tree audit. | Gate C verified |
| Create target skeleton first; no transitional production or test warehouse. | Applies | Facades/capability owners and separate tests are specified. | First compile occurs in this tree; no legacy-center copy. | Repository search finds no warehouse/old center. | Gate C verified |
| Reuse requires module-level provenance and proof of conformance; do not rename/move old center wholesale. | Applies | Every target row names provenance; only focused units/3-line bin qualify. | Implementation log records each reused focused unit. | Diff review confirms. | Gate C verified |
| One explicit state/lifecycle owner; stateless modules add no ambient mutable state. | Applies | State map assigns `LocalNoteStore`, `SyncSession`, callback lifetime. | Actual fields/tasks/locks match. | Concurrency/lifecycle tests and review. | Gate C verified |
| Gate B only after green replacement already matches Gate A; only emergent refinements. | Applies | Eligibility rule recorded. | Replacement is green, actual tree matches, and no emergent refinement is proposed. | Record user Gate B decision. | Gate C verified |
| Complete comment census before Gate B; retain only why/safety/order/lifecycle/wire/caller constraints. | Applies | Family disposition table above. | Individual final-path census complete. | No stale/narrative comments. | Gate C verified |
| Maintain source-to-evidence matrix through Gate C. | Applies | This matrix has design evidence for every row. | Add actual implementation references. | Add command/test/diff evidence. | Gate C verified |
| Generated checksum/layout changes are not semantic breakage; regenerate unsupported artifacts from preserved API. | Applies | Generated policy and current host output recorded. | Regenerate both and inspect semantic surface. | Both native binding/build paths green. | Gate C verified |
| Do not declare completion with unresolved architecture, ledger, comments, compliance, old structure or verification. | Applies | Gate A explicitly not completion; unresolved list maintained. | Resolve before Gate B/C progression. | Zero unresolved required row. | Gate C verified |
| Do not commit, push, open MR or create tasks. | Applies | No such actions performed. | Continue prohibition. | Final status confirms. | Gate C verified |

### Repository instructions and behavioral specifications

| Source + requirement | Applies? / N/A reason | Gate A design evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Root modifying-agent activation: read complete organization standard/specs/applicable AGENTS and name narrowest owner before plan/edit. | Applies | Reads and rereads after compaction recorded; owner is FFI boundary. | Complete organization standard reread through EOF after the latest compaction. | Reread refactoring standard before Gate C. | Gate C verified |
| Root §4/M6: Rust owns note rules/workflows; FFI is a thin projection and shells do not reimplement. | Applies | Dependency tree delegates to model/store/sync; no new logic. | Actual modules contain projection only. | Lower suites + public projection tests. | Gate C verified |
| Root Rust: FFI errors derive `uniffi::Error` and `thiserror::Error`. | Applies | `NoteError`/`SyncError` exact derives frozen in contract owners. | Inspect actual definitions. | Bindgen + compile + display tests. | Gate C verified |
| Root Rust/M9: regenerate bindings after FFI-visible change. | Applies | Both generation paths in verification plan. | Generate during first green. | `just build-rust-ios`; Android equivalent when available. | Gate C verified |
| Root M8: generated bindings/JNI/XCFramework are never hand-edited. | Applies | Generated classification/policy. | Git diff excludes ignored artifacts. | Final status audit. | Gate C verified |
| Root critical FFI profile rule: iOS dev; Android `release-ffi`/unwind, never plain release. | Applies | Target leaves scripts/profiles unchanged. | Config diff audit. | Native commands demonstrate profiles. | Gate C verified |
| Root M17: search sibling occurrences after changes. | Applies | Full export/caller inventory provides patterns. | `rg` old center names/comments/dependency/symbols after rewrite. | Results recorded. | Gate C verified |
| Root M18 and §7.4: run FFI/Rust/full/native verification and report commands/counts. | Applies | Baselines and final plan recorded. | Focused green before Gate B. | FFI tests, full Rust, both bindgens/native builds, Android JVM, `just check` as applicable. | Gate C verified |
| Root M19: behavior changes update specs. | No behavior change is proposed | Semantic freeze means no spec behavior edit at Gate A. | Stop for separate approval if behavior differs. | Diff confirms specs unchanged or approved update present. | N/A unless behavior changes |
| Root M1/M5; `docs/spec/app.md` render/performance: note/bootstrap/search I/O may not gate shell render or typing. | Applies to projection contract | Synchronous FFI methods remain native actor/dispatcher responsibility; search background invariant frozen. | No native lifecycle change; store bootstrap unchanged. | Native compile + store/public tests. | Gate C verified |
| `docs/spec/app.md` notes/files and where-logic-lives: file titles/path safety/note decisions are shared Rust behavior. | Applies | Rules/store remain lower-owned. | No FFI duplicate. | Model/core/store suites + rule delegation test. | Gate C verified |
| `docs/spec/list.md` list/folder/new-note/actions: metadata, folders, complete mutations, collision/backlink outcomes and title validation remain available. | Applies | Every record/action/field frozen; note contract exercises workflows. | Exact mapping preserved. | Public note test + native compile. | Gate C verified |
| `docs/spec/editor.md` tags/wikilinks/images/saving & rename: canonical rules, conditional flush and peer-delete recreate semantics remain shared. | Applies | All rule actions and write outcomes frozen. | Exact delegations/methods preserved. | Model conformance + note public contract + native compile. | Gate C verified |
| `docs/spec/search.md` behavior/ownership: `NoteStore` owns one BM25 lifecycle; status/rescan/search fields remain. | Applies | Search remains in `notes/store.rs`, not a second owner. | Actual state map matches. | Store search tests + public calls + native builds. | Gate C verified |
| `docs/spec/sync.md` connect/run: connect/session/status/summary/error surface and push-first cycle remain. | Applies | Full sync contract and state owner frozen. | Client delegates unchanged to `SyncSession`. | Sync tests + public contract + native builds; isolated server when available. | Gate C verified |
| `docs/spec/sync.md` live sync: callback set, worker delivery, note-change notification, start/stop/reconnect lifecycle remain. | Applies | `sync/events.rs`/`sync/client.rs` responsibilities fixed. | Actual callback/lifecycle mapping matches. | Shape test + native listener compile + sync tests. | Gate C verified |
| `docs/spec/sync.md` conflict/data safety: local writes/failures/message/CollectionGone remain lower-computed and distinct. | Applies | Every field/variant frozen; no caller-based reduction. | Exact conversion audited. | Sync core tests + Android outcome/reload + native builds. | Gate C verified |
| `docs/spec/desktop-rust.md` ownership analogy: adapters project owning stores rather than recreate workflows. | Applies conceptually to FFI | Target is projection modules only. | No domain logic in FFI. | Architecture review. | Gate C verified |

### Complete architecture checklist import

The following wording is imported from both `docs/architecture/codebase-organization.md` and
`/Users/mason/Downloads/codebase-refactoring.md`, § Architecture Review Checklist. Identical rows
are combined with both sources named rather than duplicated.

#### Structure

| Requirement | Applies? / Gate A evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- |
| Code is grouped under its owning feature, route, resource, or provider. | Applies: `notes/` and `sync/` are capability owners under FFI boundary. | Actual tree matches. | Final tree audit. | Gate C verified |
| Files implementing one cohesive capability are grouped in a descriptively named module folder when that improves navigation. | Applies: each capability has 3 related files and a facade. | Actual folders exist. | Navigation audit. | Gate C verified |
| Module entry points expose and orchestrate the capability instead of containing every implementation detail. | Applies: root and both `mod.rs` files are facade/re-export only. | Line/responsibility audit. | Final source inspection. | Gate C verified |
| Feature-private components and helpers remain local. | Applies to helpers: inert hooks stay in sync client; callback adapter stays events-local. No UI components are changed. | Private visibility/import audit. | `rg`/review. | Gate C verified |
| Shared code is shared by real independent consumers. | Applies: only test temp support is shared by note+sync suites; semantic root facade is intentionally shared externally. | No speculative shared helper. | Final dependency audit. | Gate C verified |
| API implementations are delegated to route-local helpers where appropriate. | N/A: no HTTP route/API implementation; this is an FFI boundary. | N/A | N/A | N/A |
| Cross-feature domain types live in a shared type location; local types do not. | Applies by analogy: exported FFI contract types live in their owning capability and are deliberately root re-exported, not a global type dump. | Actual placement review. | Final tree review. | Gate C verified |
| Tests are co-located with the behavior they verify. | Applies: pure owner tests may be inline; assembled public tests live at crate `tests/` split by capability. | Reconcile placement before Gate B. | Final test inventory. | Gate C verified |
| Imports respect ownership boundaries. | Applies: modules import lower collaborators or siblings through local capability; no reverse/native dependency. | Import graph audit. | Final review. | Gate C verified |
| Concrete modules are imported directly unless a deliberate public module exists. | Applies: private modules use concrete siblings; crate root is deliberate public facade. | Inspect imports/reexports. | Final review. | Gate C verified |
| Technical folders such as `commands/` and `utils/` exist only where they improve clarity. | Applies: none proposed; capability folders only. | No generic technical dumping ground. | Final tree audit. | Gate C verified |
| The layout is not fragmented merely to minimize file sizes. | Applies: search remains with store; contracts are real boundary owners; estimated files are cohesive. | Substantial-file responsibility/count review. | Final accounting justification. | Gate C verified |

#### Naming

| Requirement | Applies? / Gate A evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- |
| Files and exports share the same semantic name. | Applies: `store`, `rules`, `contract`, `client`, `events` paths match responsibilities; shipped export names unchanged. | Actual path/export review. | Final review. | Gate C verified |
| Functions use precise verb-and-noun names. | Applies: shipped names are contractual and precise; no vague new helper proposed. | Inspect new private names. | Final review. | Gate C verified |
| Components use role-oriented `PascalCase` names. | N/A: no UI component changes. | N/A | N/A | N/A |
| Booleans read as claims. | Applies to frozen `connected`; no new boolean planned. | Inspect any added boolean. | Final review. | Gate C verified |
| Types describe domain concepts or boundary roles. | Applies: all frozen types and module roles are domain/boundary-specific. | Actual definitions. | Final review. | Gate C verified |
| There are no vague `helper`, `manager`, `processor`, or `data` names without domain context. | Applies: target introduces none; existing native `SyncManager` is an untouched consumer. | `rg` changed paths. | Final diff review. | Gate C verified |
| File and folder names make sense without opening them. | Applies: target tree responsibilities are explicit above. | Gate B reader audit. | Final review. | Gate C verified |
| Established or externally shipped abbreviations remain intact when they are clear or contractual. | Applies: FFI, sync, I/O, BM25, E2EE and exported names remain. | No cosmetic contract rename. | Semantic API comparison. | Gate C verified |

#### Components and state

| Requirement | Applies? / Gate A evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- |
| Pages coordinate; child components render named pieces. | N/A: no page/component implementation. | N/A | N/A | N/A |
| Child components receive minimal explicit props. | N/A: no component changes. | N/A | N/A | N/A |
| Shared state is scoped to the smallest useful provider. | Applies by state-owner analogy: store state belongs to `NoteStore`; sync state to `SyncClient`/`SyncSession`; no ambient module state. | Actual state map matches. | Concurrency/architecture review. | Gate C verified |
| Loading, error, and pending states are visible and intentional. | N/A to FFI UI; frozen results/errors remain explicit, while native UI state is untouched. | N/A unless consumer edit. | Native tests if consumer edit. | N/A for planned implementation |
| State updates are immutable. | N/A: FFI projection owns no UI collection-update logic; lower owners are external. | N/A | N/A | N/A |
| Effects synchronize with external systems and clean up resources. | Applies by lifecycle analogy: live task/callback/object cleanup remains explicit in `SyncSession`/generated object ownership. | Actual start/stop/drop mapping. | Lifecycle tests/native build. | Gate C verified |

#### Functions and boundaries

| Requirement | Applies? / Gate A evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- |
| Pure transformations are separated from side effects when doing so makes the workflow easier to read or test. | Applies: contract mappings/rules are stateless; store/client own side effects. | Actual module separation. | Tests/review. | Gate C verified |
| Parent functions read as coherent narratives at a consistent abstraction level. | Applies: exported methods remain one lower call plus translation; facades only compose exports. | Function review. | Final review. | Gate C verified |
| Dense policies and substantial multi-step branches use descriptive helpers when their inline details would interrupt the workflow. | Applies, but no dense FFI policy is expected; domain policy remains lower-owned. | Any emergent dense block must be named locally or rejected as scope drift. | Final review. | Gate C verified |
| Simple branches remain inline when extraction would only add indirection. | Applies: status mapping and exhaustive variants stay readable; no symmetry helpers. | Function review. | Final review. | Gate C verified |
| Helpers were not created solely for symmetry, line count, theoretical purity, or because extraction was technically possible. | Applies: target boundaries are capability/responsibility driven; search intentionally not split. | Actual helper inventory. | Final review. | Gate C verified |
| Multi-step operations read top to bottom. | Applies: connect/sync/start-live/disconnect remain visible orchestration. | Actual function review. | Final review. | Gate C verified |
| Required async work is awaited. | Applies: all frozen async client calls remain awaited/delegated. | Compiler/review. | Async tests/native compile. | Gate C verified |
| Inputs are validated at trust boundaries. | Applies: FFI delegates title/path/server/auth validation to canonical lower owners; no bypass. | Actual calls preserve validation boundary. | Negative lower tests + public errors. | Gate C verified |
| Low-level errors gain context; boundary errors are translated safely. | Applies: exact `NoteError`/`SyncError` variants/display frozen and exhaustive. | Mapping review. | Shape/display tests + bindgen. | Gate C verified |
| External data is normalized into application-owned shapes. | Applies: lower store/sync values map once into FFI-owned records. | Contract mapping modules. | Shape/mapping tests and native compile. | Gate C verified |
| Classes are used only when instance semantics justify them. | Applies by Rust-object analogy: only `NoteStore` and `SyncClient` own durable state/lifecycle; rules/mappings remain functions/data. | No stateless object introduced. | Final type/state audit. | Gate C verified |

#### Comments and specifications

| Requirement | Applies? / Gate A evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- |
| Product behavior and acceptance criteria live in `spec/`. | Applies: specs/invariant map govern behavior; comments are dispositioned locally. | Comment census moves/deletes duplicates. | Specs/diff review. | Gate C verified |
| Comments explain non-obvious intent, sequence, constraints, or major sections. | Applies: keep families limited to safety/order/thread/lifecycle/wire/caller constraints. | Individual census complete. | Final comment audit. | Gate C verified |
| Embedded operational scripts have comments for meaningful phases and readiness checks. | Applies to unchanged build scripts; their profile/generation phase comments are preserved. | If touched, audit each phase. | Script review. | Gate C verified |
| Comments do not restate obvious code. | Applies: simple method narration and section banners slated for deletion. | Census proves. | Final audit. | Gate C verified |
| Dead code is deleted rather than commented out. | Applies: old center/duplicate test removed, never commented. | Repository/diff audit. | Final `rg`/review. | Gate C verified |
| Comments remain accurate after the change. | Applies: comments move with owners and caller-based reduction rationale is deleted. | Census accuracy check. | Final review. | Gate C verified |
| Documentation, contributor guidance, and authority references reflect every move or rename. | Applies: internal module move has no current external path docs; Cargo narrative/ledger updated. | Whole-repo `rg` old ownership claims. | Final docs/config audit. | Gate C verified |

#### Verification

| Requirement | Applies? / Gate A evidence | Gate B required evidence | Gate C required evidence | Status |
| --- | --- | --- | --- | --- |
| Relevant tests pass. | Applies: old-code FFI 6/6 and full baseline green except explicit external integrations/toolchain. | Focused replacement tests green. | Full required chain green or honestly blocked—not complete otherwise. | Gate C verified |
| Type checking passes. | Applies to Rust/native consumers. | `cargo check/test` plus generated compile. | `pnpm exec tsc --noEmit`, native builds as touched. | Gate C verified |
| Linting or formatting passes. | Applies: `cargo fmt --check`; repository lint/check at final. | Focused fmt/clippy if configured. | `just check`/format evidence. | Gate C verified |
| New files are in the narrowest correct scope. | Applies: each target/test path names its owner. | Actual tree audit. | Final review. | Gate C verified |
| The feature can be understood by following names and directories from the boundary inward. | Applies: root → notes/sync facade → contract/state/event/rules. | Gate B reader audit. | Final architecture review. | Gate C verified |
| Unused dependencies and obsolete internal compatibility scaffolding have been removed. | Applies: unused direct core edge, old center, duplicate test removed; no forwarding layer. | Dependency/old-structure audit. | `cargo tree`, `rg`, accounting. | Gate C verified |
| Supported commands, configuration keys, formats, protocols, and public surfaces remain compatible unless an intentional migration is documented. | Applies: semantic freeze; native profiles/scripts unchanged; no migration proposed. | Generated semantic diff. | Both native compiles + public shape tests. | Gate C verified |

## Gate decisions

- Gate A: approved by the user on 2026-07-16 with “Go for it.” Production implementation is
  authorized inside the exact target tree and frozen semantic contract. Approval does not
  authorize semantic pruning.
- Gate B: implementation is green and the architecture audit is complete. No emergent refinement
  was proposed. The user approved proceeding on 2026-07-16.
- Gate C: complete. The Android toolchain became available after the initial blocked run; all
  three ABI libraries, generated Kotlin bindings, native Compose debug build, and 64 JVM tests
  passed, including all five translated consumer promises.

## Verification log

| Stage | Command | Result/count | Notes |
| --- | --- | --- | --- |
| Workspace initialization | `git status --short --branch` | Clean detached worktree before edits | Supplied worktree was at `885231e`; switched to current local `main`. |
| Workspace initialization | `git switch --detach main` | PASS; HEAD `9ecd1f5` | User explicitly selected current local `main`, not `origin/main`. |
| Gate A accounting | `account_scope.py --repo . --base 9ecd... crates/futo-notes-ffi` | Base 763 prod/13 test/2 files; Gate A 763 prod/544 test/5 files | Manual mixed-file classification checked. |
| Old FFI baseline | `cargo test -p futo-notes-ffi` | PASS 1/1 | Before contract tests. |
| Workspace baseline | `just test-rust-full` | PASS; exact per-suite counts in baseline table | External server tests explicitly ignored by suite design. |
| Contract oracle | `cargo test -p futo-notes-ffi` | PASS 6/6 | 1 legacy + 5 new public tests; no ignored. |
| Formatting | `cargo fmt -p futo-notes-ffi` | PASS | Only Gate A test files formatted; production unchanged. |
| Host Swift generation | bindgen to `/tmp/futo-notes-ffi-gate-a/swift` | PASS; 3,481 Swift + 1,025 header + 3 modulemap | `swiftformat` absent warning only. |
| Host Kotlin generation | bindgen to `/tmp/futo-notes-ffi-gate-a/kotlin` | PASS; 4,143 Kotlin | `ktlint` absent warning only. |
| iOS Rust/binding path | `just build-rust-ios` | PASS | All 3 targets; dev profile; generated XCFramework/Swift. |
| iOS native consumer | first `just build-ios-native` | FAIL before compile | Missing fresh-worktree pnpm dependencies. |
| Workspace dependencies | `just install` | PASS | Resolved documented missing-vite condition. |
| iOS native consumer | second `just build-ios-native` | PASS; `** BUILD SUCCEEDED **` | Editor bundle + generated bindings + Xcode compile. |
| Android Rust/binding path | `just build-rust-android` | BLOCKED | SDK/NDK and `cargo-ndk` absent; host Kotlin generation separately passes. |
| Android consumer tests | `just test-android-native` | BLOCKED before Gradle | Same toolchain gap; Java also absent. |
| Gate B focused tests | `cargo test -p futo-notes-ffi` | PASS 5/5 | 3 note + 2 sync public tests; legacy inline duplicate removed. |
| Gate B host bindings | Swift + Kotlin bindgen to `/tmp/futo-notes-ffi-gate-b-2` | PASS | Both languages generated; formatter warnings only. |
| Gate B semantic export inventory | Compare old/new generated checksum symbol names | PASS 40/40 identical names | Values are generated-layout/documentation checksums and are intentionally not frozen. |
| Gate B iOS acceptance | `just build-ios-native` | PASS; `** BUILD SUCCEEDED **` | Regenerated and compiled after replacement. |
| Gate B dependency audit | `cargo tree -p futo-notes-ffi --depth 1` | PASS | Unused direct core dependency removed. |
| Gate C authority lease | Complete `/Users/mason/Downloads/codebase-refactoring.md` reread | PASS through EOF | Performed after Gate B approval and before Gate C cleanup. |
| Gate C documentation audit | Trace `NoteStore.relink` spec reference through current FFI, native callers, store implementation/tests | PASS; stale reference corrected | Current contract is one atomic `rename`/`move_note` workflow; no semantic API change. |
| Gate C focused verification | `cargo fmt --check -p futo-notes-ffi && cargo test -p futo-notes-ffi` | PASS 5/5 | Three note and two sync public-contract tests. |
| Gate C TypeScript | `pnpm exec tsc --noEmit` | PASS | No diagnostics. |
| Gate C scripts/diff | `bash -n scripts/build-rust-{ios,android}.sh`; `git diff --check` | PASS | Binding-script comment updates remain syntactically valid. |
| Gate C generated gaps | `just spec-gaps` then `just check` gap check | PASS; 12 gaps | `GAPS.md` line anchors regenerated after the spec correction. |
| Gate C full Rust | `just test-rust-full` | PASS | Workspace green; 27 isolated-server/SSE tests remain suite-declared ignored and 5 unrelated perf/OS tests ignored. |
| Gate C repository umbrella | `just check` | PASS | Architecture gates, conformance, lint, Svelte/TS, formatting, 788 unit + 341 editor tests, and production build green. |
| Gate C host bindings | Swift + Kotlin bindgen to `/tmp/futo-notes-ffi-gate-c-20260716` | PASS | 40 checksum symbol names; no name difference from Gate A. Formatter tools absent warning only. |
| Gate C iOS acceptance | `just build-ios-native` | PASS; `** BUILD SUCCEEDED **` | Dev-profile Rust for all three Apple targets, Swift generation/XCFramework, editor bundle, and native compile. |
| Gate C Android ABI/native | `just build-rust-android` | BLOCKED before build | SDK/NDK absent, environment variables unset, and `cargo-ndk` missing. |
| Gate C Android JVM | `just test-android-native` | BLOCKED before Gradle | Same Android toolchain gap; `java -version` confirms no Java runtime. |
| Gate C Android toolchain refresh | Android Studio JBR 21, SDK/NDK 28.2, `cargo-ndk` 4.1.2, required Rust targets | PASS | Tool paths supplied explicitly for the verification commands. |
| Gate C Android ABI/bindings | `just build-rust-android` with explicit Android/JBR environment | PASS | `release-ffi` built arm64-v8a, armeabi-v7a, and x86_64 `.so` files; Kotlin bindings regenerated. |
| Gate C Android native acceptance | `just build-android-native` with explicit Android/JBR environment | PASS; `BUILD SUCCESSFUL` | Generated bindings compiled and `app-debug.apk` assembled. |
| Gate C Android JVM acceptance | `just test-android-native` with explicit Android/JBR environment | PASS 64/64 | Zero skipped/failures/errors; both outcome and all three reload-gate scenarios passed. |
| Gate C dependency/structure | `cargo tree -p futo-notes-ffi --depth 1`; final source/comment/reference searches | PASS | Only model/store/sync owners plus boundary libraries; no old center, relink reference, warehouse, or generated artifact in the diff. |
| Gate C accounting | `account_scope.py --repo . --base 9ecd... crates/futo-notes-ffi` | 651 prod / 531 test / 13 files | Production -112 (-14.7%); tests +518; classifications manually confirmed. |

## Accounting and substantial files

- Base FFI production: 763 lines. Gate A production: 763 lines. Delta: 0 (0%).
- Base FFI tests: 13 lines/1 test. Gate A tests: 544 lines/6 tests. Delta: +531 lines,
  entirely old-code public-contract capture.
- Gate A test files and responsibilities: `note_contract.rs` 341 (assembled note/rule/store
  semantic surface), `sync_contract.rs` 155 (assembled sync semantic surface), `support/mod.rs` 35
  (shared temp tree), and the 13-line legacy inline test later replaced and removed at Gate B.
- The test increase is intentional executable-contract cost, not replacement architecture. Final
  accounting reports production, test, and module counts separately; production decreased while
  the public boundary evidence became explicit.

Gate B actual: 650 production lines across ten focused Rust production files, down 113 lines
(-14.8%) from the 763-line base. Tests are 531 lines across three test files, down 13 lines from
Gate A because the translated inline legacy test was removed. Every substantial file and
responsibility appears in the Gate B audit table above.

Final Gate C accounting is 651 production lines, 531 test lines, and 13 source/test files. The
one-line production increase after Gate B is the restored platform rationale for the deliberately
inert sync hooks. The test delta from current-main is +518 lines because the original 13-line inline
test was translated, replaced, and removed. The larger public-contract suites are intentional
boundary evidence rather than production architecture. Direct non-Rust changes are two
binding-script comment corrections, one behavioral-spec correction plus regenerated gap anchors,
the manifest/lock dependency cleanup, and this durable ledger.

## Verification limitations

- The 25 isolated-server sync integration tests and 2 SSE tests were not run because no isolated
  `FUTO_TEST_SERVER` was supplied. They remain intentionally ignored by the normal workspace suite.
  This structural FFI rewrite changes no sync engine behavior; the lower sync suite, FFI contract
  tests, generated bindings, and iOS consumer compile are green. This is recorded evidence, not an
  additional semantic rewrite finding.
- `swiftformat` and `ktlint` are absent, so UniFFI reported formatter warnings. Generation itself
  succeeded in both languages, and the checked native iOS compile succeeded.
- The external `futo-notes-store` crate emits its pre-existing unused
  `install_window_hook` warning. That collaborator is outside this rewrite scope.

## Unresolved items

None in the declared rewrite scope.

No commit, push, MR, or additional task was performed or is authorized.
