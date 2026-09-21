//! Search-engine lifecycle owned by one local vault.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futo_notes_search::{SearchConfig, SearchEngine, SearchHit, StatusObserver, DEFAULT_TOPK};

use crate::FileChange;

pub(super) struct StoreSearch {
    notes_root: PathBuf,
    state: Mutex<EngineState>,
}

enum EngineState {
    NotStarted,
    RetryPending {
        config: SearchConfig,
        on_status: StatusObserver,
        retry_after: Instant,
    },
    Running(SearchEngine),
}

// Persistent index failures must not reopen Tantivy on every keystroke.
const SEARCH_ENGINE_RETRY_COOLDOWN: Duration = Duration::from_secs(15);
const SEARCH_READY_POLL_INTERVAL: Duration = Duration::from_millis(25);

impl EngineState {
    fn start(&mut self, config: SearchConfig, on_status: StatusObserver) -> Result<(), String> {
        match SearchEngine::start(
            SearchConfig {
                notes_root: config.notes_root.clone(),
                index_dir: config.index_dir.clone(),
            },
            on_status.clone(),
        ) {
            Ok(engine) => {
                *self = Self::Running(engine);
                Ok(())
            }
            Err(error) => {
                *self = Self::RetryPending {
                    config,
                    on_status,
                    retry_after: Instant::now() + SEARCH_ENGINE_RETRY_COOLDOWN,
                };
                Err(error)
            }
        }
    }

    fn engine(&mut self) -> Option<&SearchEngine> {
        if let Self::RetryPending {
            config,
            on_status,
            retry_after,
        } = self
        {
            if Instant::now() >= *retry_after {
                let config = SearchConfig {
                    notes_root: config.notes_root.clone(),
                    index_dir: config.index_dir.clone(),
                };
                let on_status = on_status.clone();
                if let Err(error) = self.start(config, on_status) {
                    eprintln!("[store/search] retry failed: {error}");
                }
            }
        }
        match self {
            Self::Running(engine) => Some(engine),
            _ => None,
        }
    }
}

impl StoreSearch {
    pub(super) fn new(notes_root: PathBuf) -> Self {
        Self {
            notes_root,
            state: Mutex::new(EngineState::NotStarted),
        }
    }

    pub(super) fn start(
        &self,
        index_dir: PathBuf,
        on_status: StatusObserver,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "search lock poisoned".to_owned())?;
        if matches!(*state, EngineState::Running(_)) {
            return Ok(());
        }
        state.start(
            SearchConfig {
                notes_root: self.notes_root.clone(),
                index_dir,
            },
            on_status,
        )
    }

    pub(super) fn query(
        &self,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<SearchHit>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "search lock poisoned".to_owned())?;
        match state.engine() {
            Some(engine) => engine.query(query, limit.unwrap_or(DEFAULT_TOPK)),
            None => Ok(Vec::new()),
        }
    }

    pub(super) fn wait_until_ready(&self, timeout_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            // Release the lifecycle lock before waiting so queries and note
            // notifications can keep using the engine while it reconciles.
            let ready = self
                .state
                .lock()
                .ok()
                .and_then(|mut state| state.engine().map(|engine| engine.status().keyword.ready))
                .unwrap_or(false);
            if ready {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            std::thread::sleep(SEARCH_READY_POLL_INTERVAL.min(deadline - now));
        }
    }

    pub(super) fn rebuild(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(engine) = state.engine() {
                engine.rescan();
            }
        }
    }

    pub(super) fn notify(&self, change: &FileChange) {
        let Ok(state) = self.state.lock() else {
            return;
        };
        // Mutations only enqueue changes; they must never pay for an engine
        // restart. The eventual startup reconcile covers changes missed here.
        let EngineState::Running(engine) = &*state else {
            return;
        };
        match change {
            FileChange::Changed(path) => engine.notify_changed(path.clone()),
            FileChange::Removed(path) => engine.notify_removed(path.clone()),
            FileChange::Renamed { from, to } => engine.notify_renamed(from.clone(), to.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestRoot;
    use crate::LocalNoteStore;
    use std::fs;
    use std::sync::{mpsc, Arc};

    fn expire_retry_cooldown(store: &LocalNoteStore) {
        let mut state = store.search.state.lock().unwrap();
        let EngineState::RetryPending { retry_after, .. } = &mut *state else {
            panic!("expected a failed search start");
        };
        *retry_after = Instant::now();
    }

    // A failed engine start degrades (never crashes) and is retried lazily on a
    // later call — but only after the cooldown, so a persistent failure is not
    // reopened on every call. Uses the cheapest real seam: an index dir that is a
    // regular file (TantivyIndices::open's create_dir_all fails), cleared between
    // attempts so the retry can succeed.
    #[test]
    fn search_engine_start_failure_self_heals_after_cooldown() {
        let root = TestRoot::new();
        let store = LocalNoteStore::new(root.0.clone());

        let index_path = root.0.join("blocking-index");
        fs::write(&index_path, "not a directory").unwrap();
        let observer: StatusObserver = Arc::new(|_| {});

        // Degraded, not crashed: start returns Err, search stays usable (empty).
        assert!(store.start_search(index_path.clone(), observer).is_err());
        assert!(!index_path.is_dir());
        assert!(store.search("anything", None).unwrap().is_empty());

        // Cause cleared, but still WITHIN the cooldown → no re-attempt yet.
        fs::remove_file(&index_path).unwrap();
        assert!(store.search("anything", None).unwrap().is_empty());
        assert!(
            !index_path.is_dir(),
            "must not re-attempt the start within the cooldown"
        );

        // Cooldown elapsed → the next call retries and, the cause now gone, starts.
        expire_retry_cooldown(&store);
        store.search("anything", None).unwrap();
        assert!(
            index_path.is_dir(),
            "must retry and start once the cooldown elapses"
        );
    }

    #[test]
    fn wait_until_search_ready_returns_false_once_the_budget_elapses() {
        let root = TestRoot::new();
        let store = LocalNoteStore::new(root.0.clone());

        let started = Instant::now();
        assert!(!store.wait_until_search_ready(80));
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(80),
            "returned before the budget: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(5),
            "wait unbounded: {waited:?}"
        );
    }

    #[test]
    fn wait_until_search_ready_reports_readiness_of_a_real_engine() {
        let root = TestRoot::new();
        let store = LocalNoteStore::new(root.0.clone());
        store.write("note", "indexable body", None).unwrap();
        let observer: StatusObserver = Arc::new(|_| {});
        store
            .bootstrap_with_search(root.0.join("index"), observer)
            .unwrap();

        // 60s, not 10s: same background-indexer wait as the ffi note_contract
        // bootstrap test, which timed out just past 10s on a contended CI runner
        // (pipeline 32195 / job 201804).
        assert!(
            store.wait_until_search_ready(60_000),
            "keyword index never became ready"
        );
        assert!(!store.search("indexable", None).unwrap().is_empty());
    }

    #[test]
    fn failed_search_retry_rearms_the_cooldown_for_every_entry_point() {
        let root = TestRoot::new();
        let store = LocalNoteStore::new(root.0.clone());
        let index = root.0.join("blocked-index");
        fs::write(&index, "not a directory").unwrap();
        assert!(store.start_search(index.clone(), Arc::new(|_| {})).is_err());

        expire_retry_cooldown(&store);
        assert!(store.search("anything", None).unwrap().is_empty());
        fs::remove_file(&index).unwrap();

        store.rebuild_search();
        assert!(!store.wait_until_search_ready(0));
        assert!(store.search("anything", None).unwrap().is_empty());
        assert!(
            !index.exists(),
            "a failed retry must start a fresh cooldown"
        );
    }

    #[test]
    fn mutations_defer_search_restart_and_are_indexed_when_it_recovers() {
        let root = TestRoot::new();
        let store = LocalNoteStore::new(root.0.clone());
        let index = root.0.join("blocked-index");
        fs::write(&index, "not a directory").unwrap();
        assert!(store.start_search(index.clone(), Arc::new(|_| {})).is_err());
        fs::remove_file(&index).unwrap();
        expire_retry_cooldown(&store);

        store.write("Needle", "findthisword", None).unwrap();
        store.observe_external_change(FileChange::Changed("Needle.md".into()));
        assert!(!index.exists(), "note mutations must not reopen Tantivy");

        assert!(store.wait_until_search_ready(60_000));
        let hits = store.search("findthisword", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "Needle");
    }

    #[test]
    fn readiness_and_rebuild_retry_search_using_the_retained_configuration() {
        for rebuild in [false, true] {
            let root = TestRoot::new();
            let store = LocalNoteStore::new(root.0.clone());
            store.write("Needle", "findthisword", None).unwrap();
            let index = root.0.join("blocked-index");
            fs::write(&index, "not a directory").unwrap();
            let (tx, rx) = mpsc::channel();
            assert!(store
                .start_search(
                    index.clone(),
                    Arc::new(move |_| {
                        let _ = tx.send(());
                    })
                )
                .is_err());

            fs::remove_file(&index).unwrap();
            expire_retry_cooldown(&store);
            if rebuild {
                store.rebuild_search();
                assert!(index.is_dir(), "rebuild must attempt the expired retry");
            }
            assert!(store.wait_until_search_ready(60_000));
            rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let hits = store.search("findthisword", None).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].note_id, "Needle");
        }
    }

    #[test]
    fn explicit_search_start_replaces_failed_configuration_but_keeps_a_running_engine() {
        let root = TestRoot::new();
        let store = LocalNoteStore::new(root.0.clone());
        store.write("Needle", "findthisword", None).unwrap();
        let blocked = root.0.join("blocked-index");
        fs::write(&blocked, "not a directory").unwrap();
        assert!(store.start_search(blocked, Arc::new(|_| {})).is_err());

        let index = root.0.join("working-index");
        store.start_search(index.clone(), Arc::new(|_| {})).unwrap();
        assert!(store.wait_until_search_ready(60_000));
        let unused = root.0.join("unused-index");
        store
            .start_search(unused.clone(), Arc::new(|_| {}))
            .unwrap();

        assert!(index.is_dir());
        assert!(!unused.exists(), "a running engine must not be replaced");
        let hits = store.search("findthisword", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "Needle");
    }
}
