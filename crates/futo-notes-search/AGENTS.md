# AGENTS.md — futo-notes-search

The on-device search engine: a Tantivy BM25 index with one document per note (title, body, tags,
folder, mtime) plus a background indexer that reconciles at boot and then consumes incremental
change notifications. One engine serves desktop (Tauri) and both native apps through
`futo-notes-ffi`.

**It knows nothing about any shell.** Hosts hand it a notes root, an index directory, and a status
callback (`StatusObserver`), and get data back. Never add a Tauri, Swift, or Kotlin concept here.
The index directory lives outside the vault — an index file inside a vault would sync as a note.

## Modules

- **`lib.rs`**: the public surface — `SearchEngine::start`, `query`, `status`, `rescan`, and the
  host-facing change notifications `notify_changed` / `notify_removed` / `notify_renamed`, plus
  `SearchConfig`, `SearchHit`, `SearchStatus`, `DEFAULT_TOPK` (50). `SearchHit.source` is `"bm25"`
  on main, and the indexer walks `.md` and `.txt` under `SearchConfig.notes_root`.
- **`indexer.rs`**: the background indexer. Owns a tokio runtime, an mpsc channel from the host's
  file watcher, debounce timers, and keeps blocking Tantivy work off the async path.
- **`tantivy_indices.rs`**: schema and index handling.

The engine's per-vault lifecycle (start, retry, restart on vault change) is **not** here — it lives
in `futo-notes-store`'s `search.rs`, which is the only crate that should construct an engine.

## Dependencies

Tantivy stops at this crate's boundary. `scripts/check-rust-dependency-boundaries.mjs` fails if
`tantivy` reaches `futo-notes-core`, `futo-notes-model`, or `futo-notes-sync`, and if the ONNX
runtime (`ort`, `ort-sys`) reaches `futo-notes-ffi`. It runs only in CI's Rust workspace job — no
`just check` fires it — so run it by hand after touching a `Cargo.toml`.

## Verification (required)

```bash
just test-search                  # this crate's inline tests (cargo test -p futo-notes-search)
cargo test -p futo-notes-store    # the lifecycle that drives this engine
just bench-search                 # the synthetic-vault Criterion benchmarks; run when you
                                  # changed indexing or query cost
```

Benchmarks keep their comparisons in `target/criterion`; `SEARCH_BENCH_NOTES` picks the corpus size.
Index readiness is timing-sensitive under load — wait on `SearchStatus`, never a sleep (AGENTS.md
M15).
