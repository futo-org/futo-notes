//! `futo-notes-search` — the platform-agnostic on-device search engine.
//!
//! The engine owns a Tantivy BM25 index with one document per note. It indexes
//! title, body, tags, folder, and mtime. A background indexer reconciles the
//! index at boot, then consumes incremental note change notifications.
//!
//! This crate knows nothing about Tauri / iOS / Android. Hosts provide the
//! notes root, index directory, and a status callback.

mod indexer;
mod tantivy_indices;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use indexer::{Ctx, IndexerHandle, IndexerMsg};

/// Default top-K search result limit.
pub const DEFAULT_TOPK: usize = 50;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordStatus {
    pub ready: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub keyword: KeywordStatus,
}

/// A ranked search result. `source` is always `"bm25"` on main.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub note_id: String,
    pub score: f32,
    pub source: String,
}

/// Status observer invoked with a fresh [`SearchStatus`] snapshot whenever the
/// indexer makes progress. Invoked from background threads.
pub type StatusObserver = Arc<dyn Fn(&SearchStatus) + Send + Sync>;

pub struct SearchConfig {
    /// Vault root the indexer walks for `.md` / `.txt` notes.
    pub notes_root: PathBuf,
    /// Where the Tantivy index lives. Kept out of the vault.
    pub index_dir: PathBuf,
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
    /// Open the index and spawn the background indexer. Returns immediately;
    /// reconciliation runs in the background.
    pub fn start(config: SearchConfig, on_status: StatusObserver) -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("futo-search-indexer")
            .build()
            .map_err(|e| format!("build indexer runtime: {e}"))?;

        let status = Arc::new(Mutex::new(SearchStatus::default()));
        let (tx, rx) = mpsc::unbounded_channel::<IndexerMsg>();
        let ctx = Ctx::new(on_status);

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

    /// Run a query, returning up to `limit` BM25-ranked hits.
    pub fn query(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        self.handle.query(query, limit)
    }

    /// Current status snapshot.
    pub fn status(&self) -> SearchStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Force a full corpus rescan.
    pub fn rescan(&self) {
        let _ = self.tx.send(IndexerMsg::Rescan);
    }

    /// Notify the indexer that a note was added or modified at `rel_path`
    /// (relative to the vault root).
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

    #[test]
    fn bm25_engine_indexes_and_queries() {
        let vault = ScopedTempDir::new();
        let index = ScopedTempDir::new();
        std::fs::write(vault.path().join("Grocery list.md"), "milk eggs bread milk").unwrap();
        std::fs::write(vault.path().join("Pancakes.md"), "milk eggs flour").unwrap();
        std::fs::write(vault.path().join("Bank.md"), "call the bank").unwrap();

        let config = SearchConfig {
            notes_root: vault.path().clone(),
            index_dir: index.path().clone(),
        };
        let engine = SearchEngine::start(config, Arc::new(|_| {})).expect("engine starts");

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
        assert!(hits.iter().all(|h| h.source == "bm25"));
        assert!(engine.query("   ", 10).unwrap().is_empty());
    }

    /// Spec (search.md): a hyphenated query token matches as an ADJACENT
    /// phrase — `folder-scoped` matches the literal compound, not the same
    /// words separated elsewhere. A space-separated query matches both.
    /// Regression lock — no behavior change intended.
    #[test]
    fn hyphenated_query_is_an_adjacent_phrase() {
        let vault = ScopedTempDir::new();
        let index = ScopedTempDir::new();
        std::fs::write(
            vault.path().join("Compound.md"),
            "search is folder-scoped by default",
        )
        .unwrap();
        std::fs::write(
            vault.path().join("Separated.md"),
            "search is scoped to a single folder",
        )
        .unwrap();

        let config = SearchConfig {
            notes_root: vault.path().clone(),
            index_dir: index.path().clone(),
        };
        let engine = SearchEngine::start(config, Arc::new(|_| {})).expect("engine starts");

        let deadline = Instant::now() + Duration::from_secs(10);
        while !engine.status().keyword.ready {
            assert!(Instant::now() < deadline, "keyword index never became ready");
            std::thread::sleep(Duration::from_millis(25));
        }

        // Hyphenated token → phrase: only the literal compound matches.
        let hits = engine.query("folder-scoped", 10).expect("query ok");
        let ids: Vec<&str> = hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(ids.contains(&"Compound"), "expected compound hit, got {ids:?}");
        assert!(
            !ids.contains(&"Separated"),
            "non-adjacent words must not match the hyphenated phrase, got {ids:?}"
        );

        // Space-separated words → both notes match.
        let hits = engine.query("folder scoped", 10).expect("query ok");
        let ids: Vec<&str> = hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(ids.contains(&"Compound"), "expected compound hit, got {ids:?}");
        assert!(ids.contains(&"Separated"), "expected separated hit, got {ids:?}");
    }
}
