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

## Search UI *(Tauri)*

- The drawer/sidebar search bar (or Ctrl/Cmd+P) opens a search popup with the
  input autofocused; queries debounce ~100 ms. → SearchPopup.svelte
- Results show title, a folder badge when the note is foldered, and a preview
  snippet; matches include note **body** text, not just titles. Verified on
  Android Tauri 2026-06-09.
- An empty query shows the 8 most-recent notes; ✕ clears; Escape closes.
- Arrow keys navigate results, Enter opens; Ctrl/Cmd+click or Shift+click
  opens the result in a new tab. *(desktop)*

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
- Native shells: the shared `futo-notes-search` crate is exposed through the
  `futo-notes-ffi` facade as a `SearchEngine` object (constructor takes the
  notes root + an index dir; `query`/`keyword_ready`/`rescan`/`notify_*`),
  and both native shells query it — **body text beyond the stored preview
  matches** (verified 2026-06-09 on emulator + simulator: a word past the
  100-char preview window returns its note). Empty query → recent 8;
  non-empty → result count + matches with folder label; ✕ clears; tapping a
  result opens it. The substring filter remains only as the warm-up fallback
  until the keyword index is ready. Store mutations feed
  `notify_changed/removed/renamed`; a live pull triggers a `rescan`. On
  Android the engine is a **process singleton** — Tantivy's IndexWriter
  holds an exclusive directory lock, so a second construction on Activity
  recreation fails LockBusy. → futo-notes-ffi `SearchEngine`,
  SearchScreen.kt + `SearchEngineHolder` *(Android)*, SearchService.swift +
  NoteListView.swift *(iOS)*
- **Native shells run BM25-only by the same decision as Android Tauri
  below**: the FFI is built with `futo-notes-search` `default-features =
  false`, which omits the new `semantic` feature (it gates the
  `futo-notes-inference` dependency), so no ORT linkage and no model assets
  ship in the native apps. Keyword search covers note bodies; the splade
  status reports `fallbackReason: "semantic_disabled"`. Revisit alongside
  the model-packaging decision. → crates/futo-notes-search `semantic`
  feature

- **Decision (2026-06-09): shipping the SPLADE model in the Android Tauri
  binary is on hold.** The APK does not bundle the model file
  (`search_status` reports `splade.fallbackReason: "model_file_missing"`),
  so Android Tauri runs BM25-only. Keyword search still covers note bodies —
  only the semantic upgrade is absent. Revisit when binary-size/packaging is
  decided; not a gap to close today.
