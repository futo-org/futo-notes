//! Desktop Tauri shim over the platform-agnostic BM25 search engine.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use futo_notes_search::{SearchConfig, SearchEngine, SearchHit, SearchStatus};

/// Search-subsystem state, `manage()`d on the Tauri app alongside `CoreState`.
///
/// The engine is started lazily off the main thread so opening the Tantivy index
/// never blocks app setup. Until it is installed, commands return empty
/// results/status, which the frontend tolerates via its MiniSearch fallback.
#[derive(Default)]
pub struct SearchState {
    engine: Arc<Mutex<Option<SearchEngine>>>,
}

impl SearchState {
    fn install(&self, engine: SearchEngine) {
        if let Ok(mut guard) = self.engine.lock() {
            *guard = Some(engine);
        }
    }

    fn is_initialized(&self) -> bool {
        self.engine.lock().map(|g| g.is_some()).unwrap_or(false)
    }
}

/// Where the Tantivy BM25 index lives. Kept out of the notes vault, under the
/// app data dir's `search/` subfolder.
fn search_index_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = if let Ok(p) = std::env::var("FUTO_NOTES_DATA_DIR") {
        PathBuf::from(p)
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())?
    };
    let dir = base.join("search");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all search dir: {e}"))?;
    Ok(dir)
}

fn build_config(app: &AppHandle) -> Result<SearchConfig, String> {
    Ok(SearchConfig {
        notes_root: crate::core::notes_root(app)?,
        index_dir: search_index_dir(app)?,
    })
}

/// Start the background search engine and install it into [`SearchState`].
/// Idempotent. Runs the Tantivy-index open + initial reconcile spawn on a
/// background thread so app setup is never blocked.
pub fn init_on_startup(app: &AppHandle) {
    let state: State<'_, SearchState> = app.state();
    if state.is_initialized() {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("futo-search-init".into())
        .spawn(move || {
            let config = match build_config(&app) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[search] cannot build config: {e}");
                    return;
                }
            };
            let emit_app = app.clone();
            let on_status: futo_notes_search::StatusObserver =
                Arc::new(move |status: &SearchStatus| {
                    let _ = emit_app.emit("search:status", status);
                });
            match SearchEngine::start(config, on_status) {
                Ok(engine) => {
                    let state: State<'_, SearchState> = app.state();
                    state.install(engine);
                }
                Err(e) => eprintln!("[search] failed to start engine: {e}"),
            }
        })
        .ok();
}

/// Run a BM25 query over note titles, bodies, tags, and folder names.
#[tauri::command]
pub async fn search_query(
    state: State<'_, SearchState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let engine = state.engine.clone();
    let limit = limit.unwrap_or(futo_notes_search::DEFAULT_TOPK);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = engine.lock().map_err(|_| "search lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(engine) => engine.query(&query, limit),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Current indexing status.
#[tauri::command]
pub async fn search_status(state: State<'_, SearchState>) -> Result<SearchStatus, String> {
    let guard = state.engine.lock().map_err(|_| "search lock poisoned".to_string())?;
    Ok(guard.as_ref().map(|e| e.status()).unwrap_or_default())
}

/// Force a full corpus rescan. Exposed for Settings/tests, not routine edits.
#[tauri::command]
pub async fn search_rebuild(state: State<'_, SearchState>) -> Result<(), String> {
    let guard = state.engine.lock().map_err(|_| "search lock poisoned".to_string())?;
    if let Some(engine) = guard.as_ref() {
        engine.rescan();
    }
    Ok(())
}

/// Incremental index update for a single note. `kind` is one of `"add"`,
/// `"change"`, `"unlink"`, or `"rename"`; `rel_path` is the note's path
/// relative to the vault root, and `from` carries the old path for renames.
#[tauri::command]
pub async fn search_notify(
    state: State<'_, SearchState>,
    kind: String,
    rel_path: String,
    from: Option<String>,
) -> Result<(), String> {
    let guard = state.engine.lock().map_err(|_| "search lock poisoned".to_string())?;
    let Some(engine) = guard.as_ref() else {
        return Ok(());
    };
    match kind.as_str() {
        "add" | "change" => engine.notify_changed(rel_path),
        "unlink" => engine.notify_removed(rel_path),
        "rename" => match from {
            Some(f) => engine.notify_renamed(f, rel_path),
            None => engine.notify_changed(rel_path),
        },
        _ => {}
    }
    Ok(())
}
