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

    /// Serializes engine lifetimes across tests: at most one [`SearchEngine`]
    /// is alive at a time.
    ///
    /// Each engine costs a 2-worker tokio runtime plus a Tantivy writer with a
    /// 50 MB heap, and `cargo test` runs one per test thread. Growing this
    /// module from two engine tests to six made pipeline 33408 fail three of
    /// them at "keyword index never became ready" — including
    /// `bm25_engine_indexes_and_queries`, which had passed for months. The
    /// trace shows the reconcile log line printing *after* the panic, so the
    /// work completed, just past the deadline: starvation, not a hang.
    /// Serializing drops the binary's peak RSS from 160 MB to 108 MB.
    ///
    /// Honest limit: this was NOT reproduced locally (single-CPU `taskset`
    /// stress passes 3/3 both before and after), matching this runner's known
    /// locally-unreproducible timing behavior. The fix removes the concurrency
    /// the failure requires rather than waiting the flake out.
    ///
    /// Poisoning is ignored so one test's assertion failure does not cascade.
    fn engine_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENGINE_LOCK: Mutex<()> = Mutex::new(());
        ENGINE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Boot an engine over `notes` (id → body) and block until it is queryable.
    /// The returned guard serializes engine lifetimes — keep it bound for the
    /// whole test.
    #[allow(clippy::type_complexity)]
    fn engine_over(
        notes: &[(&str, &str)],
    ) -> (
        std::sync::MutexGuard<'static, ()>,
        ScopedTempDir,
        ScopedTempDir,
        SearchEngine,
    ) {
        let guard = engine_lock();
        let vault = ScopedTempDir::new();
        let index = ScopedTempDir::new();
        for (id, body) in notes {
            std::fs::write(vault.path().join(format!("{id}.md")), body).unwrap();
        }
        let engine = SearchEngine::start(
            SearchConfig {
                notes_root: vault.path().clone(),
                index_dir: index.path().clone(),
            },
            Arc::new(|_| {}),
        )
        .expect("engine starts");
        // 30s, up from 10s. [`engine_lock`] bounds contention *inside* this
        // binary, but the runner is shared with other concurrent jobs, and
        // 33408 showed a 3-file reconcile blow past 10s under that load. This
        // is the one sanctioned timeout bump (M15) — the serialization above,
        // not this number, is the actual fix.
        let deadline = Instant::now() + Duration::from_secs(30);
        while !engine.status().keyword.ready {
            assert!(
                Instant::now() < deadline,
                "keyword index never became ready"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        (guard, vault, index, engine)
    }

    fn ids(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.note_id.as_str()).collect()
    }

    #[test]
    fn bm25_engine_indexes_and_queries() {
        let (_g, _v, _i, engine) = engine_over(&[
            ("Grocery list", "milk eggs bread milk"),
            ("Pancakes", "milk eggs flour"),
            ("Bank", "call the bank"),
        ]);

        let hits = engine.query("milk", 10).expect("query ok");
        let ids: Vec<&str> = hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(
            ids.contains(&"Grocery list"),
            "expected grocery hit, got {ids:?}"
        );
        assert!(
            ids.contains(&"Pancakes"),
            "expected pancakes hit, got {ids:?}"
        );
        assert!(
            !ids.contains(&"Bank"),
            "bank should not match 'milk', got {ids:?}"
        );
        assert!(hits.iter().all(|h| h.source == "bm25"));
        assert!(engine.query("   ", 10).unwrap().is_empty());
    }

    /// Spec (search.md): a hyphenated query token matches as an ADJACENT
    /// phrase — `folder-scoped` matches the literal compound, not the same
    /// words separated elsewhere. A space-separated query matches both.
    /// Regression lock — no behavior change intended.
    #[test]
    fn hyphenated_query_is_an_adjacent_phrase() {
        let (_g, _v, _i, engine) = engine_over(&[
            ("Compound", "search is folder-scoped by default"),
            ("Separated", "search is scoped to a single folder"),
        ]);

        // Hyphenated token → phrase: only the literal compound matches.
        let hits = engine.query("folder-scoped", 10).expect("query ok");
        let ids: Vec<&str> = hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(
            ids.contains(&"Compound"),
            "expected compound hit, got {ids:?}"
        );
        assert!(
            !ids.contains(&"Separated"),
            "non-adjacent words must not match the hyphenated phrase, got {ids:?}"
        );

        // Space-separated words → both notes match.
        let hits = engine.query("folder scoped", 10).expect("query ok");
        let ids: Vec<&str> = hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(
            ids.contains(&"Compound"),
            "expected compound hit, got {ids:?}"
        );
        assert!(
            ids.contains(&"Separated"),
            "expected separated hit, got {ids:?}"
        );
    }

    /// A note containing EVERY query word outranks a short note containing only
    /// one, even when BM25 length normalization favors the short one.
    ///
    /// Regression: measured against the real 2,608-note corpus, the single note
    /// containing both query words reached rank 1 in 1 of 20 cases and top-10 in
    /// 2 of 20, because a should-clause parse lets a tiny one-term note win.
    #[test]
    fn a_note_matching_every_word_beats_a_short_one_word_note() {
        let (_g, _v, _i, engine) = engine_over(&[
            // Short and dense in "material" — the BM25 length-normalization winner.
            ("Standup material", "material"),
            // Long, mentions both words once each.
            (
                "Self managed life",
                &format!(
                    "{} material for the talk covers encryption at rest",
                    "filler ".repeat(400)
                ),
            ),
        ]);

        let hits = engine.query("material encryption", 10).expect("query ok");
        assert_eq!(
            ids(&hits).first().copied(),
            Some("Self managed life"),
            "the only note with BOTH words must rank first, got {:?}",
            ids(&hits)
        );
    }

    /// When no note contains all the words, the query still returns the notes
    /// that match some of them rather than nothing.
    #[test]
    fn a_query_no_note_fully_satisfies_falls_back_to_any_word() {
        let (_g, _v, _i, engine) = engine_over(&[
            ("Hiring", "notes about hiring engineers"),
            ("Groceries", "milk and eggs"),
        ]);

        let hits = engine
            .query("what should I do about hiring", 10)
            .expect("query ok");
        assert!(
            ids(&hits).contains(&"Hiring"),
            "an over-constrained query must degrade to any-word, got {:?}",
            ids(&hits)
        );
    }

    /// One mistyped character still finds the note.
    ///
    /// Regression: 24 of 24 single-character misspellings of otherwise-unique
    /// words returned an empty result list against the real corpus.
    #[test]
    fn a_single_character_typo_still_finds_the_note() {
        let (_g, _v, _i, engine) = engine_over(&[
            ("Cars", "an essay about driverless vehicles"),
            ("Bank", "call the bank"),
        ]);

        // deletion, substitution, insertion, transposition
        for typo in ["driverles", "drivarless", "driverlesss", "drivreless"] {
            let hits = engine.query(typo, 10).expect("query ok");
            assert!(
                ids(&hits).contains(&"Cars"),
                "typo {typo:?} should still find the note, got {:?}",
                ids(&hits)
            );
        }
    }

    /// Fuzzy is a last resort, not a default: an exactly-spelled query must not
    /// have its results diluted by edit-distance-1 neighbors.
    #[test]
    fn fuzzy_does_not_fire_when_the_exact_spelling_matches() {
        let (_g, _v, _i, engine) = engine_over(&[
            ("Exact", "cart"),
            ("Neighbor one", "cars"),
            ("Neighbor two", "cast"),
        ]);

        let hits = engine.query("cart", 10).expect("query ok");
        assert_eq!(
            ids(&hits),
            vec!["Exact"],
            "an exact match must not pull in fuzzy neighbors"
        );
    }
}
