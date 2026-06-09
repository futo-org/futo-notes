# Search — Spec

Search is **on-device hybrid retrieval**: lexical (BM25) + learned-sparse
semantic (SPLADE), fused with RRF. It replaces the old MiniSearch keyword index.
Implementation and perf details live in `docs/splade-search.md`.

## Behavior

- Results are ranked by RRF fusion of a BM25 (keyword) index and a SPLADE
  (learned-sparse) index over the note corpus.
- Search runs **fully on-device** — no query or note content leaves the device
  (consistent with E2EE).
- The index builds in the background and never blocks the UI. Keyword (BM25)
  results are available as soon as the keyword index is ready; hits upgrade from
  `bm25` to `hybrid` once the SPLADE backfill completes. Indexing is
  restart-safe — a progress sidecar avoids re-encoding the whole corpus.
- Query time is fast and **inference-free**: the SPLADE model runs only at index
  time (doc-side encoding); querying is tokenize-only with no model forward pass.
- First launch shows a one-time "Preparing model…" state while the model
  compiles (~45 s on Apple CoreML; cached afterward), then an "N / total"
  indexing progress. → SearchIndexIndicator.svelte *(splade-merge)*

## Model

- A **doc-side SPLADE encoder** (distilbert backbone, BERT MLM head) from the
  OpenSearch-project neural-sparse family, run client-side. The doc-side design
  is what makes queries inference-free. → https://huggingface.co/opensearch-project
- Acceleration: Apple Neural Engine via the CoreML EP on a patched fp16 model
  (iOS / macOS); CPU int8 EP on Linux / Windows / Android.
- 32-bit ARM devices skip the encoder (SIGBUS crash loop) and run BM25-only. →
  splade-merge `6fa1054`

## Status & platform coverage

- Implemented in the shared **`crates/futo-notes-search`** crate (Tantivy
  `bm25/` per-note + `splade/` per-chunk indices, a custom weighted-SPLADE
  scorer, and a background indexer), consumed by the Tauri app via the
  `apps/tauri/src-tauri/src/search.rs` shim — merged to this branch in
  `97b6a14`. On desktop it coexists with MiniSearch behind a status-ready gate
  (`search_status`), and `search_notify` at the TS mutation chokepoint keeps the
  index fresh. → docs/splade-search.md
- Native shells (today): substring-only filtering over title / preview / tags.
  Empty query → recent 8; non-empty → result count + matches; ✕ clears; tapping
  a result opens it. → SearchScreen.kt *(Android)*, NoteListView.swift *(iOS)*

> **Gap:** the hybrid search crate is reachable only via Tauri commands — it is
> NOT exposed through `futo-notes-ffi` (the generated Swift/Kotlin bindings have
> no search symbol; verified on-device 2026-06-04). So the native SwiftUI
> (`apps/ios`) and Compose (`apps/android`) shells stay substring-only. Wiring
> `futo-notes-search` into the FFI facade is the remaining work for the native
> apps.
