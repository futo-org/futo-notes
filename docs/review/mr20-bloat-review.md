# MR 20 Bloat & Overengineering Review

**Scope:** `4bf5261a..HEAD` — "Native iOS + Android shells on shared Rust core." +27,824 / -5,356 across 194 files (verified).

## Executive summary

The diff is fat but mostly accountable. After bucketing out tests, fixtures, docs, examples and generated artifacts, the reviewable production surface is ~15-16k lines, and the largest single chunk of *that* is irreducible: a relocated multi-client E2EE sync orchestrator plus two new native UIs. The shared Rust note-domain (rules + CRUD, single-sourced and conformance-locked) is the right investment and is well-tested.

The real, cuttable bloat clusters in a few places that multiple independent reviewers converged on:

1. **The semantic-search stack ships only to desktop** — its "shared by all three apps" framing is not honored by the wiring in this MR (all 6 personas).
2. **`futo-notes-app` is an empty 18-line re-export crate** (5 personas) — delete it.
3. **`tauri-specta` + the 622-line `bindings.ts` are generated but never imported** by any app module (0 `commands.*` call sites; 15 raw `invoke()` sites).
4. **Dead/superseded Tauri command surfaces** — `rules_*` (0 frontend callers) and the old `fs_*` note/folder commands (only referenced inside the unused `bindings.ts`).
5. **Byte-identical duplicated glue** — the LiveHandle `pull`/`push` closures and the per-command Tauri wrapper boilerplate.

This is an advisory review. I verified the high-impact claims against the code; two were wrong and are downgraded below.

## Where the +27.8k lines went (verified)

| Bucket | Added lines | Notes |
|---|---|---|
| Dedicated test files (`*/tests/`, `*.test.ts`, `*.spec.ts`) | 4,393 | measured via numstat |
| Conformance fixtures (`tests/conformance/*`) | 1,630 | TS↔Rust rule-parity contract |
| Inline `#[cfg(test)]` in crate src (approx) | ~3,900 | rough: last test module → EOF per file |
| Docs (`docs/*`) | 1,950 | incl. 672 of migration *plans*, 957 of behavioral spec |
| Examples / benches / splade scripts | 801 | dev-only |
| Generated/derived in the diff (`Cargo.lock` 1004 + `bindings.ts` 622) | 1,626 | 0% reviewable-as-logic |
| **Subtotal: non-production** | **~14,300** | **~51% of the diff** |
| **Production / hand-written feature code** | **~13,500** | the actual review burden |

**Correction to the Line-Counter's framing:** the claim that "2,431 of orchestrator.rs's 3,629 lines (67%) are tests" is **overstated**. There are two `#[cfg(test)]` markers (lines 1198 and 2779), but the one at 1198 is a *single* test-only helper `fn plan_push` (line 1199) — the code immediately after (`ConflictCopy` enum at ~1280) is production. The real test portion is the 851-line module at line 2779 plus that small helper; production is **~2,770 lines** (matching the CTO's count). The orchestrator is genuinely a large production file, not mostly tests.

**Correction #2 (refuted claim):** Grumpy-Sr-Dev's finding that the 3,060-line generated UniFFI Kotlin binding is "checked into the repo, inflating the diff" is **FALSE**. `git check-ignore` returns 0 (ignored), `git ls-files` shows it untracked, and `git diff --numstat` for that path is empty — it is build-time generated and gitignored, exactly as recommended. The Line-Counter had this right. Do not act on the Grumpy-Sr-Dev version.

## Cross-cutting themes (multi-persona convergence)

### Theme A — Semantic-search stack ships only to desktop, not the native shells the MR is named for
**Raised by all 6 personas. Confidence: high (verified).**
- `grep` for `search|splade|embed` in `crates/futo-notes-ffi/src/lib.rs` → **zero hits**. FFI's `Cargo.toml` depends only on `futo-notes-app` + `futo-notes-core` — **not** on search or inference.
- `futo-notes-search` is consumed only by `apps/tauri/src-tauri` (and by `futo-notes-inference`). Verified via Cargo.toml grep.
- Native search is a one-line substring filter: `apps/android/.../ui/SearchScreen.kt:60` `store.notes.filter { it.title.lowercase().contains(q) ... }`; `apps/ios/Sources/NoteListView.swift:23` identical. The Android source comment itself (SearchScreen.kt:45-47) says "not the ranked BM25 engine ... which is not exposed via FFI ... no semantic engine on native."
- `rust-core-migration-plan.md` mentions SPLADE 0 times; SPLADE is tracked by a *separate* plan (`splade-integration-plan.md`, status NOT STARTED).
- **This is the single largest block of production code that adds no behavior to the two new shells.** Whether to cut it is a product/architecture decision (below), but the framing must be corrected: today these crates are a Tauri feature, not a tri-platform one.

### Theme B — `futo-notes-app` is an empty pass-through crate
**Raised by 5 personas (CPO, CTO, Rustacean, Line-Counter, Grumpy-Sr-Dev). Confidence: high (verified).**
- `crates/futo-notes-app/src/lib.rs` is 18 lines: a 16-line doc comment + `pub use futo_notes_model as model;` + `pub use futo_notes_sync as sync;`.
- Only consumer is `futo-notes-ffi` (`use futo_notes_app::model; use futo_notes_app::sync::...`). Tauri does NOT depend on it (verified — no `futo-notes-app` in `apps/tauri/src-tauri/Cargo.toml`).
- Its doc promises "the orchestrator relocates here in Phase 5," but `orchestrator.rs` (3,629 lines) still lives in `futo-notes-sync`, and the crate depends on neither inference nor search — it composes nothing.
- **Recommendation:** delete it; point `futo-notes-ffi` at `futo-notes-model` + `futo-notes-sync` directly (4-line rename). Re-introduce only when Phase 5 actually relocates the orchestrator.

### Theme C — Duplicated, safety-critical sync glue (LiveHandle pull/push)
**Raised by CTO, Tauri-specialist, Grumpy-Sr-Dev. Confidence: high (verified).**
- `crates/futo-notes-ffi/src/lib.rs:439-507`: the `pull` and `push` closures are **byte-for-byte identical** except the comment text — both acquire the gate, snapshot, call `sync::orchestrator::run_sync(&snap, &notes_root, &no_progress, &no_pre_write)`, commit. Verified by reading both blocks.
- `live.rs:79` doc concedes "both desktop and native FFI run the full cycle." On the Tauri side both fields come from the same `gated_run_sync_closure` called twice.
- **Risk:** the names `pull`/`push` lie (both run a full cycle), and a future fix to one branch will silently skip the other — in safety-critical sync code. Collapse to one `cycle` closure.

### Theme D — Generated/typed-binding machinery that nobody consumes
**Raised by Tauri-specialist (sharpest), corroborated by CTO/Line-Counter on accounting. Confidence: high (verified).**
- `grep "commands\." across src/**/*.{ts,svelte}` → **0** typed-client call sites. All commands go through 15 raw `invoke('...')` sites.
- `bindings.ts` is 622 lines, carries `@ts-nocheck`, and is regenerated every desktop-debug startup + gated in CI — full cost, zero realized type-safety.
- The native shells get their typed surface from UniFFI, not from tauri-specta — so this layer contradicts "treat Tauri as a second-class citizen."

### Theme E — Dead/superseded Tauri command surfaces
**Raised by Tauri-specialist. Confidence: high (verified, with a refinement).**
- `rules_*` (13 commands): **0** frontend invocations (verified). The hot path uses the TS copy in `src/lib/rules.ts`; native shells reach the rules via FFI free functions. `rules.rs` correctly delegates to `model::` (no reimplementation), but exposing them as Tauri *commands* serves no consumer.
- `fs_*` note/folder commands: **stronger than the persona stated** — `fs_write_note_atomic`, `fs_create_folder`, `fs_rename_folder`, `fs_delete_note_to_trash`, `fs_set_mtime` are referenced ONLY inside the unused `bindings.ts` (no real `tauri.ts` invoke). They are superseded by the new `notes_*` commands and are dead from the runtime frontend.
- **Refinement:** `fs_list_notes_with_meta` is NOT dead — it has a real invoke at `src/lib/platform/tauri.ts:174`. The "two coexisting scan paths" finding (it duplicates `notes_scan`'s traversal) holds; the "delete it" framing does not.

## Prioritized recommendations

### Clear wins (high/medium impact, low-medium effort, multi-persona, verified)

| Recommendation | Impact | Effort | Personas | Confidence | Verified? |
|---|---|---|---|---|---|
| Delete `futo-notes-app`; FFI depends on model+sync directly | Low-Med | Low | CPO, CTO, Rustacean, Line-Counter, Grumpy | High | ✅ Yes |
| Collapse LiveHandle `pull`/`push` to one `cycle` closure (remove ~70-105 dup lines in FFI + Tauri) | Medium | Low | CTO, Tauri-spec, Grumpy | High | ✅ Yes |
| Decide tauri-specta: either wire the `commands.*` client for real (drop `@ts-nocheck`) OR delete the layer + revert to `generate_handler!` | High | Medium | Tauri-spec | High | ✅ Yes (0 consumers) |
| Drop the superseded `fs_*` note/folder commands + the `rules_*` command surface (keep model rules + FFI exports + conformance) | Medium | Low | Tauri-spec | High | ✅ Yes |
| Remove the Settings "Run benchmarks" button + `inference_test_embed` + dense `embedder.rs`/`download.rs` (or at least DEV-gate the button) | Medium | Low | CPO | High | ✅ Yes (not DEV-gated; 35MB ships to prod) |
| Add a CI dep-tree guard (`cargo tree | grep -q tantivy/ort` fails on core/model/sync/ffi) to lock in the good isolation | Low | Low | Rustacean | High | ✅ Yes (isolation confirmed) |

### Product / architecture decisions (judgment calls — need a human call)

| Recommendation | Impact | Effort | Personas | Confidence | Verified? |
|---|---|---|---|---|---|
| **Semantic search:** either split SPLADE/dual-Tantivy into its own MR keyed to its plan, OR wire it through FFI so it's genuinely tri-platform, OR cut it. Today it's desktop-only riding a shell-spike MR. | High | High | All 6 | High (state), Medium (cut decision) | ✅ Yes (Tauri-only) |
| **Three UIs at spike stage:** make an explicit call — pursue one native target to ship, park the other; stop treating both as maintained CI/spec surfaces until a ship decision. | High | Medium | CPO | Medium | Partial |
| **Three coexisting desktop search engines** (MiniSearch TS + BM25 + SPLADE): commit to one and set a retirement date for MiniSearch. | Medium | Medium | CPO | High | Partial (per source comments) |
| **Feature-gate the portable core** (`sync`/`search` features) so a CRUD-only / watchOS slice can compile without crypto/merge/rayon. | High | Medium | Rustacean | High | ✅ Yes (no `[features]`, unconditional aes-gcm/pbkdf2/diffy/rayon; model only uses core::files+sync) |
| **Feature-gate `SyncClient` in the FFI** so a sync-free native binary drops tokio/reqwest/rustls (~198 → ~60 crates). | High | Medium | Rustacean | Medium | Partial |

### Style / craft cleanup (low impact, low effort)

| Recommendation | Impact | Effort | Personas | Confidence | Verified? |
|---|---|---|---|---|---|
| Split `orchestrator.rs` (2,770 prod lines) into push/pull/collision/error modules; name the phases of the 440-line `run_push` | Medium | Medium | CTO, Grumpy | High | ✅ Size verified |
| Stop double-logging: route everything through `tracing`, drop the parallel `eprintln!` in library crates | Medium | Medium | Grumpy | High | Took on faith |
| Replace the env-var config channel in the SPLADE encoder with a `SpladeEncoderConfig` struct | Medium | Medium | Grumpy | High | Took on faith |
| Move the migration-narrative essays out of `orchestrator.rs` (lines 1-23) into the MR/docs; de-dup the F1 rationale in FFI | Low | Low | Grumpy, Line-Counter | Medium | Partial |
| Reconcile hardcoded sync ports (3005 vs 3100); single-source the default | Low | Low | Grumpy | Medium | Took on faith |
| Unify iOS/Android error handling (iOS `print()` is invisible in release; both swallow write failures) | Medium | Medium | Grumpy | High | Took on faith |
| Move `invariants.rs` (test-only oracle, pre-existing) into `tests/` — flag for owning team, not this MR | Low | Low | CTO | High | Took on faith |
| Replace dead `_collector_in_scope` fn with `use ... Collector as _;` | Low | Low | Grumpy | Medium | Took on faith |

## Per-lens highlights (sharpest unique finding from each persona)

- **CPO:** The dense nomic embedder (288 LOC) + 35MB model download exist solely to feed a "Run benchmarks" button — and that button is **not** behind `import.meta.env.DEV` (verified: the DEV guard is at line 535, the Benchmark section at ~472), so a real user can trigger a silent 35MB HuggingFace fetch for a feature that powers nothing.
- **CTO:** The relocation did **not** simplify sync — production sync logic grew ~30% (old `sync.rs` ~2,145 prod lines → orchestrator ~2,770). Stop describing this MR as a sync simplification; it's a decoupling that added edge-case handling.
- **Tauri-specialist:** tauri-specta is the clearest "Tauri weight not worth its keep" — an rc-pinned 3-crate dep stack + 622-line artifact + per-startup write + CI gate, for a typed client the app imports zero times.
- **Rustacean:** The ML stack (ORT/Tantivy) is *correctly* quarantined (zero transitive hits in core/model/sync/ffi — verified), but the "true core" has the opposite problem: **no feature gates**, so the minimal CRUD path unconditionally compiles the full crypto/merge/diffy/rayon stack it never calls.
- **Line-Counter:** ~half the diff is non-production; re-baseline the review on ~13-15k production lines, and do NOT count tests/fixtures as bloat-to-cut.
- **Grumpy-Sr-Dev:** Two parallel logging systems coexist — `indexer.rs` defines `splade_trace()→tracing` then logs the *same* events again via `eprintln!` (lines 1079 + 1096). Library crates shouldn't write to stderr at all.

## Disagreements & open questions

1. **Cut the search stack vs. keep it to prove portability.** The CPO wants to freeze/remove SPLADE+inference as a feature no notes user asked for. The Rustacean explicitly warns *against* merging the ML stack back into core — but that's compatible: the Rustacean is defending the *dep isolation*, not the *feature*. The actual tension is CPO ("cut the feature") vs. the migration plan's stated goal ("one search engine shared by all three apps"). **Recommendation:** the engine is not shared today; either split it to its own MR or wire it through FFI. Don't account its lines against "native shells on shared core."

2. **Is the orchestrator's complexity bloat?** Grumpy-Sr-Dev calls it a god-file; the CTO argues the four post-passes (empty-map reconcile, concurrent-move dedup, rename derivation, summary combination) are enumerated multi-client E2EE failure-mode fixes, not gratuitous abstraction. **These agree on the action** (split into modules) and **disagree only on framing.** It is real complexity; the fix is modularization + honest framing, not deletion.

3. **`fs_list_notes_with_meta` — dead or live?** Refuted as dead (it has a real caller). The remaining question is whether its bespoke `WalkDir` traversal should fold into `model::scan_notes` so vault traversal has one definition. Lower priority than the genuinely-dead `fs_*` commands.

4. **Generated Kotlin binding in the diff** — Grumpy vs. Line-Counter. **Resolved: Line-Counter is correct** (gitignored, not tracked, not in the diff). Drop the Grumpy version.

## What is NOT bloat (defend against over-correction)

- **The shared Rust note domain** (`futo-notes-model` rules + CRUD, delegating to `futo-notes-core::files`) + the **1,630-line conformance fixture set**. This is the load-bearing point of the MR. The TS↔Rust rule duplication is a *deliberate, correct* performance call (`rules.ts` documents that per-keystroke rules must not become IPC round-trips), and the conformance harness is the price of keeping the two in lockstep. Do not collapse to IPC.
- **Dep isolation of ORT/Tantivy.** Verified: zero transitive hits of tantivy/ort in core/model/sync/ffi; inference's dep on core is dev-only; per-platform EP feature flags are clean. A reviewer hunting bloat must NOT "simplify" by merging these into core — that would be the real disaster. Add a CI guard to keep it that way.
- **The sync orchestrator's intrinsic complexity.** The four post-passes are enumerated F1/F4/F5 failure-mode fixes for correct multi-client E2EE sync, not abstraction for its own sake. Modularize it; don't gut it.
- **`session.rs` `AbortableTask` trait.** Looks like premature abstraction (one in-crate impl) but there genuinely are two concrete spawn-handle types (tokio vs tauri::async_runtime). It's the lesser of two evils vs. duplicating the live-task lifecycle in both adapters. Leave as-is.
- **`docs/spec/*`** — the behavioral source-of-truth layer is legitimately behavior-bearing. Only `docs/spec/settings-visual.md` (420 lines, pixel-for-pixel) is worth questioning as spec-ahead-of-code, and the `splade-integration-plan.md` (NOT STARTED, targets a different worktree) probably doesn't belong on this branch.
