# SPLADE sparse-search backend

On-device sparse vector search via SPLADE (BERT MLM head, distilbert backbone). Replaces the old MiniSearch TS keyword index and the custom binary SPLADE sparse-index with a unified Tantivy + hybrid-fusion architecture. The doc encoder runs on Apple Neural Engine when available, falling back to CPU on Linux/Windows/Android. Queries are inference-free — tokenize-only on the SPLADE WordPiece vocab, no model forward pass at search time.

## What works today

**Architecture** (`apps/tauri/src-tauri/src/search/`)

- `tantivy_indices.rs` — two Tantivy indices side by side. `bm25/` is one doc per note (title + body + tags + folder + mtime fast field). `splade/` is one doc per chunk; each expansion term is repeated `round(weight * SPLADE_SCALE)` times so Tantivy's term frequency *is* the quantized weight. A small version sidecar (`splade.version`) auto-rebuilds the splade dir on incompatible schema changes.
- `splade_scorer.rs` — custom `WeightedSpladeQuery` that walks posting lists ourselves and computes `Σ (query_weight * doc_term_freq / SPLADE_SCALE)`. We can't reuse Tantivy's `TermQuery` because we want the raw `term_freq` as the per-term contribution, not BM25.
- `indexer.rs` — long-lived tokio task. At boot: reconcile BM25 fast (one tokio task, emits `keyword.ready = true`), then drive SPLADE backfill in 16-note batches with progress events. A `splade-progress.json` sidecar tracks the last successfully-encoded mtime per note so app restarts don't re-encode the corpus.
- Hybrid fusion: BM25 top-50 + SPLADE top-50 → RRF fuse (`futo_notes_core::search::rrf_fuse`). Returned hits are tagged `"bm25"` until SPLADE is ready, then `"hybrid"`.

**Performance — Apple Silicon (M-series)**

| Configuration | notes/sec | Notes |
|---|---|---|
| int8 ONNX, CPU baseline (bench) | 9.5 | Original behavior |
| int8 CPU, batch 32 + sort-by-length (bench) | 15.9 | +67% from batching |
| fp16 ONNX (patched) + ANE EP (bench, 500 notes) | **112.7** | **12× baseline** |
| Release in-app, 500 real-vault notes E2E | **26.8** | Includes Tantivy ingest |

On a ~2500-note vault: ~90 sec backfill + 45 sec one-time CoreML compile (cached across launches by Apple's compiler).

## The fp16 Neural Engine path — what we learned

The single biggest perf win on Apple Silicon comes from routing the SPLADE encode through ONNX Runtime's CoreML execution provider with an fp16 model. Getting there required graph surgery.

### Why the int8 model can't use CoreML

The int8 model is dynamic INT8 weight-only quantization (`MatMulInteger`, `DynamicQuantizeLinear`). CoreML's operator set has no quantized-integer matmul. When CoreML EP scans the graph it claims none of the heavy matmuls and they all fall back to ORT CPU — indistinguishable from CPU-only.

### Why the original fp16 export didn't load

`scripts/build-splade-onnx.py` produced an fp16 variant with `onnxconverter_common.float16.convert_float_to_float16` and an `op_block_list` that kept Div / Sqrt / Where / Equal / Less / Greater / Min / Max in fp32. Intent: keep attention scaling (`scores / sqrt(d_k)`) and mask-fill ops in fp32 to avoid mixed-precision issues. The converter is supposed to insert Cast nodes at every fp16 ↔ fp32 boundary; for distilbert's attention block it didn't. ORT rejected the graph at `Session::commit_from_file`:

```
Type Error: Type parameter (T) of Optype (Div) bound to different types
  (tensor(float16) and tensor(float)) in node
  (/distilbert/transformer/layer.0/attention/Div)
```

The Div had fp16 left input (attention scores from a fp16 MatMul) and fp32 right input (sqrt(d_k) from a Sqrt in the block_list). Three independent boundary mismatches per attention layer, six layers, plus the mask-fill Where → 19 disagreements total.

### Three fixes tried in parallel — what each told us

We ran three approaches against the same workload (500 real-vault notes, batch=1, seq=128 static, ANE units):

1. **Patch the existing fp16 ONNX in place** (`scripts/patch-fp16-casts.py`). Walks the graph, runs shape inference, splices a `Cast` node on every disagreeing input. Heuristic for target type: prefer the existing output type if known, else input[0]. Result: **19 Cast nodes inserted, 112.7 notes/s**. Idempotent — re-running on an already-patched model adds 0 Casts.
2. **Rerun export with `onnxruntime.transformers.float16.convert_float_to_float16`** (`scripts/build-splade-onnx-ort.py`). ORT's transformer-specific converter inserts boundary Casts correctly. Loads cleanly out of the box, no patcher needed. **95.7 notes/s**.
3. **Shrink the op_block_list to only ML-classifier ops** (`scripts/build-splade-onnx-minblock.py`). Push Div/Sqrt/Where/Equal/Less/Greater/Min/Max into fp16 so more of the attention block stays on ANE. Still needed a post-conversion Cast pass to fix boundary mismatches. **96.2 notes/s**.

**The patcher won.** Same model, same hardware, same workload, **+17%** over the cleanly-converted models. The mechanism: option (1) starts from a graph where the original block_list created one large fp16 island and one small fp32 island around attention scaling, then patches just the boundary between them. Options (2)/(3) produce graphs with more Cast nodes scattered through the attention block, which fragments what CoreML EP can claim — instead of one big fp16 subgraph routing to ANE, you get smaller subgraphs with CPU fallback at every Cast.

Takeaway: **fewer, larger fp16/fp32 regions beat many small ones when targeting CoreML.** The "obviously correct" full-fp16 conversion is not necessarily the fastest. Adopted in `scripts/build-splade-onnx.py` as a post-conversion step; the alternative scripts are kept in `scripts/` as reference.

### Other knobs that landed

- `FUTO_COREML_UNITS=ane` is the new default in `crates/futo-notes-inference/src/splade_encoder.rs`. On our patched fp16 model ANE is ~3× faster than GPU and ~2× faster than CPU+GPU.
- `FUTO_SPLADE_FIXED_SEQ=128 FUTO_SPLADE_BATCH1=1` is set by the indexer when loading the fp16 variant. CoreML's MLProgram compiler refuses dynamic shapes on ANE — every dim has to be static. Chunker target retargeted to 96 estimated tokens to fit inside the 128-token window without truncation.
- `SPLADE_SCALE` lowered from 100 → 32. 5-bit quantization is sufficient (SPLADE weights below ~0.03 are noise) and per-chunk Tantivy `Token` allocations scale linearly with the scale. Modest end-to-end win (+19% in the in-app indexer) because encode dominates over ingest, but lower scale also means a smaller index on disk.

### What didn't help

- **Parallel encoder pool**: with 2 ORT sessions on ANE, throughput stayed the same — there's only one ANE chip and contention washes out the parallelism. Worth re-trying with one session on ANE + one on GPU for mixed-unit pipelining, but not yet done.
- **`pool=2 --intra-threads 4`** on CPU: 15.4 notes/s vs 15.9 single-pool — rayon already saturates the CPU; doubling sessions just adds overhead.
- **Larger `SPLADE_BATCH_SIZE`** in the indexer: encoder is at batch=1 anyway (CoreML static shape), so flat-batching more notes only reduces outer-loop bookkeeping, which is already ≪1% of total.

## UI state — the 45s CoreML compile

`SpladeDocEncoder::load` on the fp16 variant pays a ~40–45s one-time CoreML compile on first launch. CoreML caches the compiled MLProgram per model hash; subsequent launches are near-instant as long as the .onnx file content doesn't change.

`SpladeStatus` gained a `compiling: bool` field. The indexer sets it to `true` before `SpladeDocEncoder::load` and clears it after, emitting a `search:status` event each time. `SearchIndexIndicator.svelte` shows "Preparing model…" while `compiling` is true so users don't see a frozen "0 / N" during the compile.

## Pooled output contract

The upstream `fill-mask` export emits `logits [batch, seq, vocab]` (vocab =
30522) and the Rust encoder pooled it on the CPU: `relu → masked max over seq →
log(1 + log(1 + x))`. `scripts/fuse-splade-pool.py` moves that tail into the
ONNX graph, so the model now outputs `pooled [batch, vocab]` directly.

Why (and why not):
- **GPU-ready — the main reason**: a small pooled output is the prerequisite for
  an efficient GPU copy-back if/when a CUDA/DirectML EP lands — without it, you'd
  copy the full `[N, seq, 30522]` logits back over PCIe every run.
- **Clean output contract**: the model hands back `[batch, 30522]` (~120 KB/doc
  fp32), not `[batch, seq, 30522]`. The dense per-token tensor is gone.
- **It does NOT speed up CPU — it's slightly slower.** Measured ~8% *slower* on
  Linux CPU int8 (9.5 vs 10.3 notes/s; `splade_bench`, 60 notes, threads=4). The
  Rust pool was already cheap: it reads ORT's output via a zero-copy view and
  applies `log(1+log(1+x))` only to the few hundred surviving nonzeros, whereas
  the graph runs `Relu`+`Mul` over the full `[N, seq, 30522]` and `Log` over the
  full `[N, 30522]` — strictly more work. So **bundle the fused model only where
  a GPU EP is active; keep the un-fused model on CPU-only platforms.** The
  encoder auto-detects either output, so this is a per-platform model-bundling
  choice, not a code change.

It also does **not** remove the need to sub-batch (`MAX_SEQS_PER_RUN = 32`): the
`[N, seq, vocab]` tensor still exists as an internal transient feeding the
`ReduceMax`, so a giant note flattened into one run can still blow up memory.

The encoder auto-detects the contract: it uses `pooled` when the model exposes
it, else pools dense `logits` on the CPU. So fused and un-fused models both work
(e.g. a not-yet-refused CoreML fp16 model keeps using the CPU fallback).
Parity is gated by the `fused_model_matches_unfused` test in
`crates/futo-notes-inference/tests/splade_parity.rs` (set `SPLADE_POOLED_MODEL_PATH`).

**Build integration:** the canonical pipeline should run the fusion after export.
When `build-splade-onnx.py` is brought into this branch, apply
`fuse-splade-pool.py` to the fp32 graph right after `main_export` so every
downstream variant (int8 dynamic, fp32 static, fp16) inherits the pooled output;
the fp32-static `update_inputs_outputs_dims` call then maps `{"pooled": [1, 30522]}`
instead of `{"logits": [1, 128, 30522]}`. Until then, run it standalone against
the per-platform `gen/{linux,android,apple}/splade-model.onnx`.

## Files

**New**
- `apps/tauri/src-tauri/src/search/{mod,indexer,splade_scorer,tantivy_indices}.rs` — the whole subsystem
- `scripts/fuse-splade-pool.py` — graph surgery (onnx-only): appends the activation + masked max-pool to the encoder so it outputs `pooled [batch, vocab]` instead of dense `logits [batch, seq, vocab]`. Idempotent; works on the int8/fp32/fp16 variants. Run it after export (see "Pooled output contract")
- `scripts/patch-fp16-casts.py` — graph surgery, idempotent
- `scripts/build-splade-onnx-ort.py` — alternative export using ORT's converter (kept for reference)
- `scripts/build-splade-onnx-minblock.py` — alternative export with shrunk block_list (kept for reference)
- `src/lib/search.svelte.ts` — TS bindings + reactive status store
- `src/components/SearchIndexIndicator.svelte` — corner indicator with "Preparing model…" / "N / total" states

**Changed**
- `scripts/build-splade-onnx.py` — runs `patch-fp16-casts.py` as step 4c after the fp16 conversion
- `crates/futo-notes-inference/src/splade_encoder.rs` — default `FUTO_COREML_UNITS=ane`; reads a `pooled [batch, vocab]` model output when present, else falls back to pooling dense `logits` on the CPU (see "Pooled output contract")
- `apps/tauri/src-tauri/gen/apple/assets/splade-model-fp16.onnx` — replaced with patched version

**Removed**
- `src/lib/searchIndex.ts`, `src/lib/sparseSearch.ts`, `crates/futo-notes-core/src/sparse_index.rs` — old MiniSearch + custom binary index

## Open questions / next steps

- **Encode + ingest pipelining**: while the encoder computes batch N+1 on ANE, batch N could write to Tantivy on CPU in parallel. Estimated +25% end-to-end. Non-trivial refactor (needs a bounded channel between encode thread and ingest thread).
- **Mixed-unit pool**: one ORT session on ANE + one on GPU, encoder slot selected by `FUTO_COREML_UNITS_IDX`. Bench harness already supports this via `--pool 2`; the indexer doesn't. Worth a try if pipelining doesn't close the gap.
- **Encoder-load cache validation**: confirm the 45s compile drops to <1s on second launch (Apple's compile cache hit). Easy to verify; just hasn't been measured cleanly yet.
- **Linux/Windows ANE-equivalent**: no equivalent of ANE on x86. The CPU-int8 path stands at ~10–15 notes/s. Possible wins: WebGPU/DirectML/CUDA EPs, but each is a separate integration with its own model-format constraints. Out of scope for now.

## iOS deployment — landmines and fixes

Deploying the same patched fp16 + ANE path to iOS surfaced several non-obvious Tauri / Xcode / iOS bundling quirks. The summary of each, and the fix we landed.

### Tauri `bundle.resources` truncates source files on iOS

Tauri's CLI processes `bundle.resources` entries during the iOS build's pre-bundle phase. Its bookkeeping creates a placeholder at the *source* path if it doesn't already exist in a staging location — but the staging location and the source location overlapped (`gen/apple/assets/X` ↔ `gen/apple/assets/X`), so `create-truncate` zeroed the 181 MB fp16 model and the 712 KB tokenizer right before Xcode copied them into the `.app`. The deployed bundle had 0-byte files; `Tokenizer::from_file` returned `EOF while parsing a value at line 1 column 0`; the encoder reported `encoder_load_failed`; the UI showed the warning icon.

Fix: **remove `bundle.resources` from `tauri.conf.json`**. iOS bundling is driven by `gen/apple/project.yml`:

```yml
- path: assets
  buildPhase: resources
  type: folder
```

That folder reference already copies the directory contents into the bundle (`CpResource gen/apple/assets → FUTO Notes Dev.app/assets`). The `bundle.resources` mapping was duplicate work that only made things worse for iOS. macOS bundling (`/Applications/FUTO Notes.app/Contents/Resources/`) needs a separate pathway — currently relies on the per-platform `bundle.linux.{deb,rpm,appimage}.files` style; a `bundle.macOS`-scoped resources block is the right schema, pending Tauri schema confirmation.

### `resource_dir()` on iOS isn't the bundle root

On macOS Tauri's `app.path().resource_dir()` returns `Contents/Resources/`. On iOS it returns `<bundle>/assets/` (one level deeper, because the `type: folder` reference adds that path component). The locator now probes **both** layouts:

```rust
let assets_candidate = resource.join("assets").join(name);   // macOS-style nested
if assets_candidate.exists() { return Some(assets_candidate); }
let candidate = resource.join(name);                          // iOS direct
if candidate.exists() { return Some(candidate); }
```

The `search_debug_paths` Tauri command in `apps/tauri/src-tauri/src/search/mod.rs` returns the resolved paths + file sizes — useful when stderr is unreachable on a real iPhone (see below).

### Physical-iPhone stderr is dropped — debug via MCP, not logs

The simulator pipes the app's stderr to `os_log` with a `[stderr]` prefix, so `eprintln!` from `load_encoder` ("resolved model=… (N bytes) tokenizer=… (M bytes)") shows up in `idevicesyslog`. **On a physical iPhone, stderr goes to `/dev/null`** — `eprintln!` is invisible. The trace-log helper that writes to `/tmp/futo-splade-trace.log` also dies (sandbox: `deny(1) file-write-create /private/var/tmp/...`).

Workaround: the Tauri MCP bridge listens on `0.0.0.0:9223` in debug builds. Forward it over USB and query Tauri commands directly:

```bash
iproxy 9224 9223 &
node scripts/mcp-invoke.mjs --port 9224 search_status
node scripts/mcp-invoke.mjs --port 9224 search_debug_paths
node scripts/mcp-invoke.mjs --port 9224 search_query '{"query":"foo","limit":5}'
```

`scripts/mcp-invoke.mjs` wraps the Tauri MCP bridge's custom WebSocket protocol (`{id, command: "execute_js", args: {script}}`) and JSON-stringifies the Tauri invoke result so it round-trips cleanly.

### `xcodebuild` developer-disk-image mount can fail; `devicectl` works

`cargo tauri ios dev` shells out to `xcodebuild` which requires the iOS DDI to be mountable on the device. If the device hasn't been "prepared for development" since an OS update, this errors with:

```
xcodebuild: error: Timed out waiting for all destinations…
  error: The developer disk image could not be mounted on this device.
```

The fix is to install via `xcrun devicectl device install app` (which mounts a different developer service that doesn't gate on DDI staleness) after a one-time `xcrun devicectl manage pair`. This is what the new `just ios-dev` physical-device branch does. It also builds with `cargo tauri ios build --debug` (bundles `dist/` instead of pointing at a dev URL) so the app works on networks that block iPhone↔Mac peer traffic (coffee-shop Wi-Fi, conference networks).

### Performance on physical iPhone (iPhone 17 Pro)

Benchmarked end-to-end on the device via the MCP-bridge USB tunnel — 1013 seeded notes (~4 chunks/note), full rescan, ANE:

| Build | notes/sec | total_ms |
|---|---|---|
| **iPhone 17 Pro, debug, 1013 notes** | **11.18** | 90,619 |
| macOS debug in-app, 103 notes | 14.9 | 6,900 |
| macOS release in-app, 500 real notes | 26.8 | 18,700 |
| macOS release bench, 500 notes | 112.7 | — |

iPhone debug-build throughput tracks macOS debug-build throughput (within 25% — the small extra on iPhone is consistent with batch=1 ANE having lower steady-state throughput than the M-series ANE on this model). Expectation for iPhone release: ~25-30 notes/sec, scaling the same as macOS dev→release. The CoreML MLProgram compile is cached on the device for the model's content hash, so second-launch encoder loads are near-instant.

Bench harness: `scripts/bench-ios-indexer.mjs` — triggers `search_rebuild`, waits for the indexer's blocking task to start (`splade.total` transitions to the new count), then polls `search_status` every 500 ms until `ready=true`. Reports a per-batch timeline and a notes/sec headline.

Seeder: `scripts/seed-ios-notes.mjs [count]` — pushes N synthetic notes into the device's app sandbox via the `fs_write_note_atomic` Tauri command, batched in one `execute_js` call to avoid 1000× WebSocket round-trips.

### Quick reference

| Workflow | Path |
|---|---|
| `just ios-dev` (simulator booted) | `cargo tauri ios dev` (HMR, devUrl) |
| `just ios-dev` (physical iPhone connected) | `cargo tauri ios build --debug` → `devicectl install` → `iproxy` MCP tunnel |
| `just deploy-ios` (release) | `cargo tauri ios build` → `devicectl install` (production bundle ID, signed for App Store) |
| Probe the running iOS app | `node scripts/mcp-invoke.mjs --port 9224 <cmd> [json-args]` |
| Pull resolved SPLADE paths + sizes | `node scripts/mcp-invoke.mjs --port 9224 search_debug_paths` |
