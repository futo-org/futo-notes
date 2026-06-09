//! `futo-notes-search` — the platform-agnostic on-device search engine.
//!
//! Two [Tantivy](https://docs.rs/tantivy) indices side by side:
//!
//! - **BM25** (`bm25/`): one doc per note (title + body + tags + folder + mtime).
//! - **SPLADE** (`splade/`): one doc per chunk; each SPLADE expansion term is
//!   repeated `round(weight * SPLADE_SCALE)` times so Tantivy's term frequency
//!   *is* the quantized weight, scored by a custom [`splade_scorer`].
//!
//! A background indexer reconciles BM25 fast at boot (so keyword search is live
//! immediately), then backfills SPLADE in batches via the doc encoder in
//! `futo-notes-inference`. Queries fuse BM25 top-K + SPLADE top-K with
//! Reciprocal Rank Fusion (`futo_notes_core::search::rrf_fuse`); the SPLADE
//! query path is inference-free (tokenize-only, no model forward pass).
//!
//! ## Platform-agnostic by construction
//!
//! This crate knows **nothing** about Tauri / iOS / Android. It takes explicit
//! paths plus a [`StatusObserver`] callback and returns data:
//!
//! - **Status** is pushed to the host via the [`StatusObserver`] closure
//!   ([`SearchConfig`] + [`SearchEngine::start`]). The Tauri layer's closure
//!   calls `app.emit`; the FFI layer's drives a callback interface.
//! - **Paths** (index dir, model + tokenizer files) are passed in via
//!   [`SearchConfig`]. *Resolving* those paths (bundle `resource_dir`, Android
//!   asset extraction, exe-sibling probing) is the host's job — see
//!   [`SpladeModelVariant`].
//! - **Runtime**: the engine owns a dedicated tokio runtime for its background
//!   indexer, so it needs no ambient runtime; [`SearchEngine::query`] /
//!   [`SearchEngine::status`] are synchronous.

mod indexer;
mod splade_scorer;
mod tantivy_indices;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use indexer::{Ctx, IndexerHandle, IndexerMsg};

/// Quantization scale: SPLADE weights are multiplied by this and rounded to
/// produce Tantivy term frequencies. Higher = better precision, larger index.
///
/// 32 gives 5-bit precision (min representable weight = 1/32 ≈ 0.031). SPLADE
/// weights below ~0.05 are noise — they correspond to expansion-term logits in
/// the bottom of the activated distribution and don't drive retrieval. The
/// per-token allocation cost in `build_splade_pretokenized` scales linearly
/// with this value (each expansion term emits `round(weight * SCALE)` Tantivy
/// `Token` clones), so smaller is better as long as quality holds.
pub const SPLADE_SCALE: f32 = 32.0;

/// Default top-K per index before RRF fusion.
pub const DEFAULT_PER_INDEX_TOPK: usize = 50;

// ---------------------------------------------------------------------------
// Status types (portable serde structs — shared verbatim with the host layers)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordStatus {
    pub ready: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpladeStatus {
    pub ready: bool,
    pub indexed: u32,
    pub total: u32,
    /// First-launch compile of the CoreML MLProgram blocks `SpladeDocEncoder::load`
    /// for ~40s on Apple Silicon. We surface that as a distinct UI state so the
    /// indicator doesn't look frozen at "0 / N".
    pub compiling: bool,
    /// One of: "model_file_missing", "encoder_load_failed",
    /// "armv7_unsupported", "indexer_crashed", or None.
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub keyword: KeywordStatus,
    pub splade: SpladeStatus,
}

/// A ranked search result. `source` is `"bm25"` until SPLADE is ready, then
/// `"hybrid"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub note_id: String,
    pub score: f32,
    /// "bm25" | "hybrid"
    pub source: String,
}

/// The SPLADE model variant the host resolved. fp16 is the CoreML-friendly
/// fixed-shape build (Apple); int8 is the cross-platform dynamic-shape default.
///
/// The host picks the variant when it resolves the model file (a desktop/macOS
/// build prefers fp16 + CoreML; Linux/Windows/Android use int8) and passes it
/// in via [`SearchConfig`]. The engine uses it to set the encoder env knobs and
/// chunker target — it does not itself probe the filesystem for which file
/// exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpladeModelVariant {
    Int8Dynamic,
    Fp16Static128,
}

/// Status observer invoked with a fresh [`SearchStatus`] snapshot whenever the
/// indexer makes progress. The host decides where it goes (Tauri → `app.emit`,
/// FFI → a Swift/Kotlin callback interface). Invoked from background threads.
pub type StatusObserver = Arc<dyn Fn(&SearchStatus) + Send + Sync>;

/// Engine configuration. Every path is explicit — the engine never resolves a
/// default location itself.
pub struct SearchConfig {
    /// Vault root the indexer walks for `.md` / `.txt` notes.
    pub notes_root: PathBuf,
    /// Where the Tantivy indices + progress sidecar live (kept out of the
    /// vault). The engine creates it if missing.
    pub index_dir: PathBuf,
    /// SPLADE ONNX model file. `None` → keyword (BM25) only, no encoder load.
    pub model_path: Option<PathBuf>,
    /// SPLADE WordPiece `tokenizer.json`. `None` → keyword (BM25) only.
    pub tokenizer_path: Option<PathBuf>,
    /// Which variant `model_path` is (drives env knobs + chunker target).
    pub model_variant: SpladeModelVariant,
}

/// The search engine. Construct with [`SearchEngine::start`]; query with
/// [`SearchEngine::query`]. Holds the background indexer + its tokio runtime
/// alive for as long as the engine lives.
pub struct SearchEngine {
    tx: mpsc::UnboundedSender<IndexerMsg>,
    status: Arc<Mutex<SearchStatus>>,
    handle: IndexerHandle,
    /// Owned runtime for the background indexer. Dropping the engine shuts it
    /// down. Kept last so it drops after the channel sender.
    _runtime: tokio::runtime::Runtime,
}

impl SearchEngine {
    /// Open the indices and spawn the background indexer. Returns immediately —
    /// reconciliation + SPLADE backfill run in the background; observe progress
    /// via `on_status` or [`SearchEngine::status`].
    pub fn start(config: SearchConfig, on_status: StatusObserver) -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("futo-search-indexer")
            .build()
            .map_err(|e| format!("build indexer runtime: {e}"))?;

        let status = Arc::new(Mutex::new(SearchStatus::default()));
        let (tx, rx) = mpsc::unbounded_channel::<IndexerMsg>();
        let ctx = Ctx::new(
            on_status,
            config.model_path,
            config.tokenizer_path,
            config.model_variant,
        );

        // `indexer::spawn` is synchronous but calls `tokio::spawn` internally,
        // so it must run inside the runtime context. The guard only needs to be
        // held across the spawn call; the spawned task then lives on the
        // runtime's worker threads.
        let handle = {
            let _guard = runtime.enter();
            indexer::spawn(ctx, config.notes_root, config.index_dir, rx, status.clone())?
        };

        Ok(Self {
            tx,
            status,
            handle,
            _runtime: runtime,
        })
    }

    /// Run a query, returning up to `limit` ranked hits. BM25-only until the
    /// SPLADE backfill reports ready, then hybrid (BM25 + SPLADE via RRF).
    /// Synchronous; safe to call from any thread (e.g. a host `spawn_blocking`).
    pub fn query(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        self.handle.query(query, limit)
    }

    /// Current status snapshot.
    pub fn status(&self) -> SearchStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Force a full corpus rescan (clears cached encode progress and re-runs
    /// reconcile + backfill).
    pub fn rescan(&self) {
        let _ = self.tx.send(IndexerMsg::Rescan);
    }

    /// Notify the indexer that a note was added or modified at `rel_path`
    /// (relative to the vault root). Coalesced + debounced.
    pub fn notify_changed(&self, rel_path: String) {
        let _ = self.tx.send(IndexerMsg::Changed(rel_path));
    }

    /// Notify the indexer that a note at `rel_path` was removed.
    pub fn notify_removed(&self, rel_path: String) {
        let _ = self.tx.send(IndexerMsg::Removed(rel_path));
    }

    /// Notify the indexer of an atomic rename.
    pub fn notify_renamed(&self, from: String, to: String) {
        let _ = self.tx.send(IndexerMsg::Renamed { from, to });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    /// Auto-cleanup temp dir (mirrors the tantivy_indices test helper).
    struct ScopedTempDir(PathBuf);
    impl ScopedTempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("futo-search-engine-test-{ms}-{n}"));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
        fn path(&self) -> &PathBuf {
            &self.0
        }
    }
    impl Drop for ScopedTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// End-to-end BM25-only path: no SPLADE model configured, so the engine
    /// reconciles the keyword index and serves `"bm25"` hits. Exercises
    /// `start → reconcile → query` over a real (temp) vault, with the engine's
    /// owned runtime — no ambient tokio runtime required.
    #[test]
    fn bm25_only_engine_indexes_and_queries() {
        let vault = ScopedTempDir::new();
        let index = ScopedTempDir::new();
        std::fs::write(vault.path().join("Grocery list.md"), "milk eggs bread milk").unwrap();
        std::fs::write(vault.path().join("Pancakes.md"), "milk eggs flour").unwrap();
        std::fs::write(vault.path().join("Bank.md"), "call the bank").unwrap();

        let config = SearchConfig {
            notes_root: vault.path().clone(),
            index_dir: index.path().clone(),
            model_path: None,
            tokenizer_path: None,
            model_variant: SpladeModelVariant::Int8Dynamic,
        };
        let engine = SearchEngine::start(config, Arc::new(|_| {})).expect("engine starts");

        // Wait for the keyword index to reconcile (runs in a background blocking
        // task). Poll the status snapshot rather than sleeping a fixed time.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !engine.status().keyword.ready {
            assert!(Instant::now() < deadline, "keyword index never became ready");
            std::thread::sleep(Duration::from_millis(25));
        }

        let hits = engine.query("milk", 10).expect("query ok");
        let ids: Vec<&str> = hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(ids.contains(&"Grocery list"), "expected grocery hit, got {ids:?}");
        assert!(ids.contains(&"Pancakes"), "expected pancakes hit, got {ids:?}");
        assert!(!ids.contains(&"Bank"), "bank should not match 'milk', got {ids:?}");
        assert!(hits.iter().all(|h| h.source == "bm25"), "BM25-only mode");

        // Empty query returns nothing.
        assert!(engine.query("   ", 10).unwrap().is_empty());
    }
}
