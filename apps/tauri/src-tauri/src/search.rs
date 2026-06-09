//! Desktop Tauri shim over the platform-agnostic `futo-notes-search` engine.
//!
//! The heavy lifting — two Tantivy indices (BM25 + SPLADE), the background
//! indexer, the sparse scorer, and RRF fusion — lives in `futo-notes-search`,
//! which knows nothing about Tauri. This module is the *only* Tauri-aware
//! layer: it resolves on-disk paths (notes root, index dir, bundled SPLADE
//! model + tokenizer), supplies a status-observer callback that does
//! `app.emit("search:status", …)`, and exposes the `#[tauri::command]`s the
//! frontend calls. The same engine is consumed by the native shells via the
//! FFI `SearchEngine` (a sibling thin layer); nothing here is shared with that
//! path beyond the engine crate itself.
//!
//! BM25 is live the moment the keyword index reconciles at boot; SPLADE
//! backfills in the background and queries fuse BM25 ⊕ SPLADE once it is ready.
//! If no SPLADE model is bundled the engine runs BM25-only — search still
//! works, it just stays keyword-only (`source: "bm25"`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use futo_notes_search::{
    SearchConfig, SearchEngine, SearchHit, SearchStatus, SpladeModelVariant,
};

/// Search-subsystem state, `manage()`d on the Tauri app alongside `CoreState`.
///
/// The engine is started lazily off the main thread (see [`init_on_startup`])
/// so opening the Tantivy indices never blocks app setup — consistent with the
/// project's never-gate-render discipline. Until it is installed, the commands
/// return an "initializing" error / empty status, which the frontend tolerates
/// (it keeps MiniSearch as the coexisting fallback during the parity window).
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

/// Where the Tantivy indices + SPLADE progress sidecar live. Kept out of the
/// notes vault, under the app data dir's `search/` subfolder.
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

/// Probe known on-disk locations for the bundled SPLADE ONNX model.
///
/// Returns `None` (→ BM25-only) when no model is bundled, which is the current
/// desktop default — model bundling for Linux/Windows is a later step in the
/// integration plan. On Apple platforms with CoreML compiled in we prefer the
/// fp16 fixed-shape build; everything else uses the int8 dynamic-shape model.
/// Mirrors the probe order of the legacy splade-merge `locate_splade_model_file`
/// (env override → exe sibling → install `../lib/futo-notes/` → bundle
/// resource dir), minus the Android APK-asset extraction (native handles that).
fn locate_model(app: &AppHandle) -> Option<(PathBuf, SpladeModelVariant)> {
    if let Ok(p) = std::env::var("SPLADE_MODEL_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some((path, SpladeModelVariant::Int8Dynamic));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let prefer_fp16 = std::env::var("FUTO_COREML_OFF").is_err();
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let prefer_fp16 = false;

    let try_variant = |name: &str| -> Option<PathBuf> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let sibling = parent.join(name);
                if sibling.exists() {
                    return Some(sibling);
                }
                let lib = parent.join("../lib/futo-notes").join(name);
                if lib.exists() {
                    return Some(lib);
                }
            }
        }
        if let Ok(resource) = app.path().resource_dir() {
            let assets_candidate = resource.join("assets").join(name);
            if assets_candidate.exists() {
                return Some(assets_candidate);
            }
            let candidate = resource.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    };

    if prefer_fp16 {
        if let Some(p) = try_variant("splade-model-fp16.onnx") {
            return Some((p, SpladeModelVariant::Fp16Static128));
        }
    }
    if let Some(p) = try_variant("splade-model.onnx") {
        return Some((p, SpladeModelVariant::Int8Dynamic));
    }
    None
}

/// Probe known on-disk locations for the SPLADE WordPiece `tokenizer.json`.
fn locate_tokenizer(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SPLADE_TOKENIZER_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("splade-tokenizer.json");
            if sibling.exists() {
                return Some(sibling);
            }
            let lib = parent.join("../lib/futo-notes/splade-tokenizer.json");
            if lib.exists() {
                return Some(lib);
            }
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        let assets_candidate = resource.join("assets").join("splade-tokenizer.json");
        if assets_candidate.exists() {
            return Some(assets_candidate);
        }
        let candidate = resource.join("splade-tokenizer.json");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Pair a probed model + tokenizer: SPLADE needs BOTH, so if either is missing
/// the engine runs BM25-only (drop both to `None`). Pure so it can be tested
/// without an `AppHandle`.
fn pair_model_tokenizer(
    model: Option<PathBuf>,
    tokenizer: Option<PathBuf>,
) -> (Option<PathBuf>, Option<PathBuf>) {
    match (model, tokenizer) {
        (Some(m), Some(t)) => (Some(m), Some(t)),
        _ => (None, None),
    }
}

/// Resolve every path the engine needs and build its [`SearchConfig`]. A
/// missing SPLADE model (or tokenizer) is not an error — it degrades the engine
/// to BM25-only by leaving `model_path`/`tokenizer_path` as `None`.
fn build_config(app: &AppHandle) -> Result<SearchConfig, String> {
    let notes_root = crate::core::notes_root(app)?;
    let index_dir = search_index_dir(app)?;
    let (model_path, model_variant) = match locate_model(app) {
        Some((p, v)) => (Some(p), v),
        None => (None, SpladeModelVariant::Int8Dynamic),
    };
    let (model_path, tokenizer_path) = pair_model_tokenizer(model_path, locate_tokenizer(app));
    Ok(SearchConfig {
        notes_root,
        index_dir,
        model_path,
        tokenizer_path,
        model_variant,
    })
}

/// Start the background search engine and install it into [`SearchState`].
/// Idempotent. Runs the (potentially slow) Tantivy-index open + initial
/// reconcile spawn on a background thread so app setup is never blocked.
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
            // The status observer is the engine's single coupling to Tauri:
            // every progress snapshot is forwarded to the webview verbatim.
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

/// Run a hybrid query. BM25-only until the SPLADE backfill is ready, then
/// BM25 ⊕ SPLADE fused via RRF.
#[tauri::command]
pub async fn search_query(
    state: State<'_, SearchState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let engine = state.engine.clone();
    let limit = limit.unwrap_or(futo_notes_search::DEFAULT_PER_INDEX_TOPK);
    // The engine query is synchronous + does blocking Tantivy work; run it off
    // the async runtime's worker so the IPC executor isn't held.
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

/// Current indexing status: keyword readiness + SPLADE backfill progress.
#[tauri::command]
pub async fn search_status(state: State<'_, SearchState>) -> Result<SearchStatus, String> {
    let guard = state.engine.lock().map_err(|_| "search lock poisoned".to_string())?;
    Ok(guard.as_ref().map(|e| e.status()).unwrap_or_default())
}

/// Force a full corpus rescan (clears cached SPLADE encode progress and
/// re-runs reconcile + backfill). Exposed for the Settings "rebuild index"
/// affordance and tests — NOT for routine edits (use [`search_notify`]).
#[tauri::command]
pub async fn search_rebuild(state: State<'_, SearchState>) -> Result<(), String> {
    let guard = state.engine.lock().map_err(|_| "search lock poisoned".to_string())?;
    if let Some(engine) = guard.as_ref() {
        engine.rescan();
    }
    Ok(())
}

/// Incremental index update for a single note, driven by the frontend's
/// existing `fs:change` subscription. `kind` is one of `"add"`, `"change"`,
/// `"unlink"`, or `"rename"`; `rel_path` is the note's path relative to the
/// vault root, and `from` carries the old path for renames. These are
/// debounced + mtime-aware inside the engine, so this is cheap to call on every
/// edit (unlike `search_rebuild`, which force-re-encodes the whole corpus).
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
            // No old path: treat as a fresh add of the new path.
            None => engine.notify_changed(rel_path),
        },
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::pair_model_tokenizer;
    use std::path::PathBuf;

    #[test]
    fn pairs_only_when_both_present() {
        let m = || Some(PathBuf::from("/models/splade-model.onnx"));
        let t = || Some(PathBuf::from("/models/splade-tokenizer.json"));

        // Both present → SPLADE enabled (both kept).
        let (model, tok) = pair_model_tokenizer(m(), t());
        assert!(model.is_some() && tok.is_some());

        // Tokenizer missing → drop the model too (BM25-only).
        let (model, tok) = pair_model_tokenizer(m(), None);
        assert!(model.is_none() && tok.is_none());

        // Model missing → drop the tokenizer too.
        let (model, tok) = pair_model_tokenizer(None, t());
        assert!(model.is_none() && tok.is_none());

        // Neither → BM25-only.
        let (model, tok) = pair_model_tokenizer(None, None);
        assert!(model.is_none() && tok.is_none());
    }
}
