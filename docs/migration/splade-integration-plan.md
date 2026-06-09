# SPLADE Search Integration Plan — native iOS + Android + desktop Tauri

**Status:** NOT STARTED. Handoff doc for a fresh session.
**Worktree:** `/home/justin/Developer/futo-notes/.claude/worktrees/native-ios-spike-splade`
**Branch:** `native-ios-spike-splade`, based on `worktree-native-ios-spike` @ `e0b988b`.
**Audience:** A fresh Claude Code session picking this up cold. Self-contained —
you should not need the originating conversation.

---

## Goal

Get the on-device SPLADE hybrid search (already built on `origin/splade-merge`,
where it works only inside the **Tauri** app) running across all three apps:
**desktop Tauri, native iOS (SwiftUI), and native Android (Compose)** — sharing
one platform-agnostic Rust engine with thin per-platform layers. Search stays
fully on-device (E2EE-consistent).

The behavioral source of truth for what search should do is
[`docs/spec/search.md`](../spec/search.md) — read it first.

## Decisions already made (do not relitigate)

1. **One agnostic engine crate.** Rename the existing `futo-notes-index` crate to
   **`futo-notes-search`** and fold the Tantivy + SPLADE engine into it. Retire
   the custom BM25 currently in that crate. The crate must know **nothing** about
   Tauri / iOS / Android — it takes paths + a status callback and returns data.
2. **Go straight to the shared crate.** Do NOT stage the engine inside the Tauri
   app crate first. The Tauri coupling on `splade-merge` is shallow (3 things,
   see below); rewriting it into an abstraction is mechanical. Building a
   throwaway Tauri-crate version would mean wiring the Tauri layer twice.
3. **Validate against desktop Tauri first**, then FFI, then native — desktop has
   the fastest loop (no device, no NDK/xcframework, no on-device model bundling,
   and the `window.__testSearch` hook already exists). This is the only thing we
   keep from the old "desktop-first" idea — no throwaway code.
4. **Drop MiniSearch entirely** (`src/lib/searchIndex.ts` + test, any
   `sparseSearch.ts`, `crates/futo-notes-core/src/sparse_index.rs` if present).

## Where the source of truth lives: `origin/splade-merge`

That branch carries the working, benchmarked implementation plus the design doc.
**Do not merge the branch** — it bundles a pile of unrelated work (iOS keyboard
fixes, a perf pass, macOS tabs, a sync error indicator, the mac-iOS regression
suite) that overlaps files this branch already changed and will conflict.
Selective-checkout only.

Read `docs/splade-search.md` on that branch first — it is the authoritative
design + perf + landmines doc:

```bash
git show origin/splade-merge:docs/splade-search.md | less
# and bring it into this worktree for reference:
git checkout origin/splade-merge -- docs/splade-search.md
```

### Architecture (from that doc, condensed)

- Two **Tantivy** indices side by side: `bm25/` (one doc per note: title + body +
  tags + folder + mtime) and `splade/` (one doc per chunk; each SPLADE expansion
  term repeated `round(weight * SPLADE_SCALE)` times so Tantivy term-frequency
  *is* the quantized weight). `SPLADE_SCALE = 32`.
- `splade_scorer.rs` — a custom `WeightedSpladeQuery` that walks posting lists and
  computes `Σ (query_weight * doc_term_freq / SPLADE_SCALE)` (can't reuse
  Tantivy's `TermQuery`, which would apply BM25).
- Hybrid = BM25 top-50 + SPLADE top-50 → RRF fuse via
  `futo_notes_core::search::rrf_fuse`. Hits tagged `"bm25"` until SPLADE is
  ready, then `"hybrid"`.
- **Doc-side SPLADE encoder** (distilbert backbone, BERT MLM head) — an
  OpenSearch-project neural-sparse model run client-side. Queries are
  **inference-free** (tokenize-only on the WordPiece vocab; no model forward
  pass at search time). Encoder is in `crates/futo-notes-inference`.
- Background `indexer.rs`: at boot, reconcile BM25 fast (emit `keyword.ready`),
  then SPLADE backfill in 16-note batches with progress events. A
  `splade-progress.json` sidecar tracks last-encoded mtime per note so restarts
  don't re-encode.
- Acceleration: Apple Neural Engine via CoreML EP on a **patched fp16** model
  (iOS/macOS); CPU int8 EP on Linux/Windows/Android. **32-bit ARM skips the
  encoder** (SIGBUS crash loop) → BM25-only. First launch pays a one-time
  ~45 s CoreML compile (cached after), surfaced as "Preparing model…".
- Encoder env knobs (indexer sets these): `FUTO_COREML_UNITS=ane`,
  `FUTO_SPLADE_FIXED_SEQ=128`, `FUTO_SPLADE_BATCH1=1` (CoreML MLProgram needs
  static shapes on ANE). On native these must be set in-process before encoder
  load, not via shell env.

### The Tauri coupling you must strip (it is shallow)

`apps/tauri/src-tauri/src/search/{mod,indexer,splade_scorer,tantivy_indices}.rs`
depend on Tauri for exactly three things:

1. **Status events** — `emit_status(app, &status)` → `app.emit("search:status", …)`.
   Replace with a status-observer callback the engine invokes; the Tauri layer's
   callback calls `app.emit`, the FFI layer's calls a `SearchStatusListener`.
2. **Model/index paths** — `resource_dir()` / `app_search_dir(app)`. Replace with
   explicit `index_dir` + `model_dir` constructor params.
3. **Runtime** — `tauri::async_runtime::spawn / spawn_blocking`. Replace with
   plain `tokio` spawns (the engine owns/receives a runtime; `futo-notes-ffi`
   already runs tokio for `SyncClient`).

Types are already portable serde structs: `SearchHit`, `SearchStatus`,
`KeywordStatus`, `SpladeStatus`. Keep them in the shared crate.

## Starting point on THIS branch (what's already here)

- Native shells exist: `apps/ios` (SwiftUI) and `apps/android` (Compose), both
  over the `futo-notes-ffi` UniFFI facade.
- `futo-notes-ffi` depends on `futo-notes-app` + `futo-notes-core` **only** — NOT
  `inference` or `index`. Adding search pulls `inference` (→ ORT) into the native
  FFI build for the first time. **This is the ORT-on-native trigger.**
- `crates/futo-notes-index` exists (custom BM25 + RRF) → this is the crate you
  rename to `futo-notes-search`. `futo-notes-app/Cargo.toml:17` depends on it;
  workspace members list it in `Cargo.toml`.
- `rrf_fuse` lives in `crates/futo-notes-core/src/search.rs` (core), referenced
  from the index crate. The new engine uses core's `rrf_fuse`. `splade-merge`
  extends `core/src/search.rs` — hand-merge that.
- `apps/android/.../ui/SearchScreen.kt` is substring-only over FFI metadata
  (title/preview/tags). This is the native search UI you replace in Phase 4.
- There is a sibling worktree `splade-search-wip` (branch
  `worktree-splade-search-wip`) on disk if you want a working checkout to poke at.

## Target architecture

```
crates/futo-notes-search   ← agnostic engine (renamed from futo-notes-index).
  (Tantivy bm25 + splade,    Tantivy indices + WeightedSpladeQuery + background
   RRF via core, encoder      indexer. Takes index_dir + model_dir + a status
   via futo-notes-inference)  callback. Zero Tauri/iOS/Android knowledge.
        │
        ├── apps/tauri/src-tauri/src/search/mod.rs   ← thin layer #1 (PERMANENT):
        │       registers tauri::commands, callback→app.emit, paths via
        │       resource_dir. VALIDATE HERE FIRST.
        │
        └── futo-notes-ffi  (SearchEngine + SearchStatusListener callback) ← thin layer #2
              ├── apps/ios     SwiftUI search view
              └── apps/android Compose SearchScreen.kt   (replaces substring filter)

  deleted: src/lib/searchIndex.ts (+ test), MiniSearch.
```

## Phased plan

### Phase 0 — Feasibility gate (DO FIRST; can change everything)

Cross-compile the heavy deps for mobile targets before committing to the design.
If Tantivy or `ort` won't build for `aarch64-apple-ios` / Android ABIs, STOP and
reassess (the rest of the plan assumes they do).

```bash
# encoder crate already supports load-dynamic; test it + a tantivy spike:
cargo build -p futo-notes-inference --no-default-features --features load-dynamic \
  --target aarch64-linux-android
cargo build -p futo-notes-inference --no-default-features --features load-dynamic \
  --target aarch64-apple-ios
# add tantivy to a scratch crate (or the renamed search crate) and repeat.
```

Verify: green cross-compile for both. Confirm where ORT + model land in
`scripts/build-rust-android.sh` / `scripts/build-rust-ios.sh`.

### Phase 1 — Build `futo-notes-search` (agnostic) + validate on desktop

1. **Rename crate.** `git mv crates/futo-notes-index crates/futo-notes-search`;
   update its `Cargo.toml` (`name`, `lib.name`), `Cargo.toml` workspace members,
   and `futo-notes-app/Cargo.toml:17`. Build to confirm the rename is clean.
2. **Bring in source material** from `splade-merge`:
   ```bash
   git checkout origin/splade-merge -- \
     crates/futo-notes-inference/src/splade_encoder.rs \
     crates/futo-notes-inference/tests/splade_parity.rs \
     crates/futo-notes-inference/examples/splade_bench.rs \
     crates/futo-notes-inference/examples/splade_hello.rs \
     scripts/fetch-splade-model.mjs scripts/build-splade-onnx.py \
     scripts/build-splade-onnx-ort.py scripts/build-splade-onnx-minblock.py \
     scripts/patch-fp16-casts.py \
     src/lib/search.svelte.ts \
     src/components/SearchIndexIndicator.svelte src/components/SearchStatusBadge.svelte
   ```
   Hand-merge (take only search hunks): `crates/futo-notes-inference/Cargo.toml`,
   `crates/futo-notes-inference/src/lib.rs`, `crates/futo-notes-core/src/search.rs`,
   `justfile` (model fetch/build recipes), `src/App.svelte` (`__testSearch` async
   hook), `src/components/{NotesShell,SearchPopup,SettingsScreen}.svelte`,
   `src/lib/notesIndex.ts`.
3. **Author the engine into `crates/futo-notes-search/src/`** using the four
   `apps/tauri/src-tauri/src/search/*.rs` files from `splade-merge` as source
   (`git show origin/splade-merge:apps/tauri/src-tauri/src/search/indexer.rs`,
   etc.), stripping the Tauri coupling (callback / paths / tokio — see above).
4. **Thin Tauri layer:** write `apps/tauri/src-tauri/src/search/mod.rs` as the
   single place `#[tauri::command]`s live — `search_query` / `search_status` /
   `search_rebuild` / `search_debug_paths` — calling `futo-notes-search`, with a
   callback that does `app.emit("search:status", …)` and paths from
   `resource_dir()`. Register the commands + state in the Tauri builder.
5. **Drop MiniSearch:** `git rm src/lib/searchIndex.ts src/lib/searchIndex.test.ts`;
   remove `sparseSearch.ts` / `core/sparse_index.rs` if present; repoint the
   frontend at the new async `search.svelte.ts`.
6. **Model fetch for desktop:** wire `scripts/fetch-splade-model.mjs` +
   `build-splade-onnx.py` into the relevant `just` recipe; bundle for
   Linux/Windows (macOS path is on `splade-merge`; doc notes Linux/Windows
   bundling was still pending there).

Verify: `cargo test -p futo-notes-search` (port `splade_parity`); desktop Tauri
build; `window.__testSearch`/`search_status`/`search_query` return hybrid hits;
"Preparing model…" → progress → results.

### Phase 2 — Expose via `futo-notes-ffi` (UniFFI)

- Add `futo-notes-search` (→ `inference`) as an ffi dependency.
- UniFFI `SearchEngine` object: `new(notes_root, index_dir, model_dir)`,
  `async query(text, limit) -> Vec<SearchHit>`, `status() -> SearchStatus`,
  `async rebuild()`. Use `#[uniffi::export(async_runtime = "tokio")]` (same
  pattern as `SyncClient`).
- A `SearchStatusListener` UniFFI **callback interface** for indexing progress
  (Kotlin/Swift implement it); the engine's status callback drives it. Polling
  `status()` is an acceptable simpler first cut.
- Regenerate Kotlin + Swift bindings; symbol-match (see how the build scripts do
  it for the existing facade).

Verify: bindings generate; a Rust-side unit test drives `SearchEngine` end to end.

### Phase 3 — Native ORT + model bundling (the heavy, error-prone part)

- **Android:** build `futo-notes-ffi` with `inference`'s `load-dynamic`; ship
  `libonnxruntime.so` per ABI into `apps/android/app/src/main/jniLibs/<abi>/`
  (reuse `scripts/fetch-ort-android.mjs` logic, retargeted to the native app).
  Bundle model + tokenizer into `app/src/main/assets/`; extract to filesDir on
  first run (the native app already does asset staging for `editor.html`).
- **iOS:** link the ORT xcframework into the `apps/ios` Xcode project (reuse
  `scripts/fetch-ort-ios.mjs`); build the ffi staticlib against it. Add model +
  tokenizer to Xcode resources; resolve the path at runtime. Expect bundling
  landmines — read the "iOS deployment" section of `docs/splade-search.md`; the
  native build will have its own variants.
- Wire the **32-bit ARM → BM25-only** guard (`splade-merge` commit `6fa1054`).
- Set the encoder env knobs in-process before load.

Verify: native Android + iOS builds link ORT and load the model (no
`encoder_load_failed`); `SearchEngine.status()` reaches `ready`.

### Phase 4 — Native search UI

- `apps/android/.../ui/SearchScreen.kt`: replace the substring filter with
  `SearchEngine.query`; add a "Preparing model… / N of total" status surface
  driven by `status()`/the listener. Keep the existing empty-query "recent"
  behavior.
- iOS SwiftUI search view: same.
- Update `docs/spec/search.md`: flip the native shells from "substring-only" to
  hybrid; close the FFI gap note.

### Phase 5 — Verify per platform

- Rust: `cargo test` (parity + engine).
- Desktop: build + search smoke.
- Native: seed a vault (`scripts/seed-ios-notes.mjs` pattern), rebuild index,
  query, confirm hybrid results + status UI; perf sanity vs the doc's baselines
  (~11 notes/s iPhone debug, ~27 macOS release).

## Risks

1. **Model + ORT bundling on native** — biggest, most error-prone. Budget real
   time. The doc's iOS-Tauri landmine list foreshadows native-build variants.
2. **Tantivy/ORT mobile cross-compile** — the Phase-0 gate. Untested here.
3. **Mobile memory/storage** — ~180 MB fp16 model (or int8) + per-chunk index on
   a phone. `SPLADE_SCALE=32` keeps the index smaller; watch RAM during backfill.
4. **Shared-file hand-merges** clobbering this branch's native/IME/live-sync work
   — selective checkout avoids it, but merge `App.svelte`/`justfile`/`core/search.rs`
   by hand, taking only search hunks.
5. **First-launch compile + background indexing UX on native** — needs the status
   path through FFI (the callback interface), the one genuinely new FFI pattern.

## Kickoff commands

```bash
cd /home/justin/Developer/futo-notes/.claude/worktrees/native-ios-spike-splade
git checkout origin/splade-merge -- docs/splade-search.md   # read it first
# then Phase 0 cross-compile gate (above) before any code changes.
```

## Key references

- Behavioral SoT: `docs/spec/search.md` (this worktree).
- Design/perf/landmines: `docs/splade-search.md` (on `origin/splade-merge`).
- Engine source to adapt: `origin/splade-merge:apps/tauri/src-tauri/src/search/*.rs`.
- Encoder: `crates/futo-notes-inference` (mobile-aware: ORT feature flags,
  pure-Rust tokenizers).
- Prior FFI facade pattern (async + constructor): `crates/futo-notes-ffi/src/lib.rs`
  (`SyncClient`).
- ORT fetch scripts to reuse: `scripts/fetch-ort-{android,ios,linux}.mjs`.
