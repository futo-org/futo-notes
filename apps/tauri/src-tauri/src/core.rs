use notify::{
    event::ModifyKind, Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use stonefruit_core::files::{file_mtime_ms, set_file_mtime_ms};
#[cfg(test)]
use stonefruit_core::hash::hash_sha256_bytes;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use stonefruit_core::files::{now_ms, write_atomic_text};

#[derive(Default)]
pub struct CoreState {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    suppressed_watcher_events: Arc<Mutex<HashMap<String, i64>>>,
    sync_writes_until: Arc<AtomicI64>,
}

const WATCHER_SUPPRESSION_MS: i64 = 5_000;

const NOTES_DIR_OVERRIDE_FILE: &str = "notes-dir-override.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NotesDirOverride {
    notes_dir: Option<String>,
}

/// Returns the custom data directory set via STONEFRUIT_DATA_DIR env var, if present.
/// Used to redirect app data to a per-worktree isolated directory during development.
fn env_data_dir() -> Option<PathBuf> {
    std::env::var("STONEFRUIT_DATA_DIR").ok().map(PathBuf::from)
}

fn override_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = env_data_dir() {
        return Ok(data_dir.join(NOTES_DIR_OVERRIDE_FILE));
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir.join(NOTES_DIR_OVERRIDE_FILE))
}

fn load_notes_dir_override(app: &AppHandle) -> Option<PathBuf> {
    let path = override_file_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let over: NotesDirOverride = serde_json::from_str(&raw).ok()?;
    over.notes_dir.map(PathBuf::from)
}

fn save_notes_dir_override(app: &AppHandle, dir: Option<&str>) -> Result<(), String> {
    let path = override_file_path(app)?;
    let over = NotesDirOverride {
        notes_dir: dir.map(String::from),
    };
    let serialized = serde_json::to_string_pretty(&over).map_err(|e| e.to_string())?;
    write_atomic_text(&path, &serialized)
}

pub(crate) fn io_err_to_string(err: io::Error) -> String {
    err.to_string()
}

pub(crate) fn task_join_err<E: std::fmt::Display>(err: E) -> String {
    format!("background task failed: {err}")
}

fn default_notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Explicit env override (used by dev launcher and cross-platform tests
    //    for per-worktree isolation).
    if let Some(data_dir) = env_data_dir() {
        return Ok(data_dir.join("notes"));
    }

    // 2. Debug builds NEVER touch the user's production notes folder.
    //    They default to ~/Documents/fake-notes so developers can point any
    //    local sync server at the same folder. A dev build can still be
    //    pointed elsewhere via Settings (writes `notes-dir-override.json`)
    //    or via `STONEFRUIT_DATA_DIR` for per-worktree test isolation.
    #[cfg(debug_assertions)]
    {
        let docs = app
            .path()
            .document_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| e.to_string())?;
        return Ok(docs.join("fake-notes"));
    }

    // 3. Release default: ~/Documents/stonefruit (or app-data fallback).
    #[cfg(not(debug_assertions))]
    {
        let docs = app
            .path()
            .document_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| e.to_string())?;
        Ok(docs.join("stonefruit"))
    }
}

pub(crate) fn notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = if let Some(custom) = load_notes_dir_override(app) {
        custom
    } else {
        default_notes_root(app)?
    };
    fs::create_dir_all(&root).map_err(io_err_to_string)?;
    Ok(root)
}

// ── V2 Sync apply (write path for E2EE sync) ───────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncApplyInput {
    pub update: Vec<V2IncomingUpdate>,
    pub delete: Vec<String>,
    pub conflicts: Vec<V2IncomingConflict>,
    #[serde(default)]
    pub timestamps: HashMap<String, i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V2IncomingUpdate {
    pub filename: String,
    pub content: String,
    pub hash: String,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V2IncomingConflict {
    pub filename: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncApplyOutput {
    pub updated_filenames: Vec<String>,
    pub deleted_filenames: Vec<String>,
    pub conflict_filenames: Vec<String>,
    pub elapsed_ms: u128,
}

fn apply_sync_delta_v2_impl(
    base: &Path,
    suppressed_watcher_events: &Arc<Mutex<HashMap<String, i64>>>,
    sync_writes_until: &Arc<AtomicI64>,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let started = Instant::now();
    sync_writes_until.store(now_ms() + WATCHER_SUPPRESSION_MS, Ordering::Release);

    let mut updated_filenames = Vec::new();
    let mut deleted_filenames = Vec::new();
    let mut conflict_filenames = Vec::new();

    let suppress_filename = |filename: &str| {
        if let Ok(mut map) = suppressed_watcher_events.lock() {
            let expires_at = now_ms() + WATCHER_SUPPRESSION_MS;
            map.insert(filename.to_string(), expires_at);
            map.retain(|_, expiry| *expiry > now_ms());
        }
    };

    // Delete files
    for filename in &input.delete {
        suppress_filename(filename);
        let path = base.join(filename);
        let _ = fs::remove_file(&path);
        deleted_filenames.push(filename.clone());
    }

    // Write updates
    for update in &input.update {
        suppress_filename(&update.filename);
        let path = base.join(&update.filename);
        write_atomic_text(&path, &update.content)?;

        // 0 means "no timestamp from server" — keep the filesystem's own mtime
        if update.modified_at > 0 {
            let _ = set_file_mtime_ms(&path, update.modified_at);
        }

        updated_filenames.push(update.filename.clone());
    }

    // Write conflict copies
    for conflict in &input.conflicts {
        suppress_filename(&conflict.filename);
        let path = base.join(&conflict.filename);
        write_atomic_text(&path, &conflict.content)?;
        conflict_filenames.push(conflict.filename.clone());
    }

    // Correct local file mtimes from server-authoritative timestamps.
    // This fixes files that were already up-to-date (same hash) but had wrong mtimes.
    for (filename, server_mtime) in &input.timestamps {
        if *server_mtime > 0 {
            let path = base.join(filename);
            if let Ok(meta) = fs::metadata(&path) {
                if file_mtime_ms(&meta) != *server_mtime {
                    suppress_filename(filename);
                    let _ = set_file_mtime_ms(&path, *server_mtime);
                }
            }
        }
    }

    sync_writes_until.store(now_ms() + WATCHER_SUPPRESSION_MS, Ordering::Release);

    Ok(V2SyncApplyOutput {
        updated_filenames,
        deleted_filenames,
        conflict_filenames,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[tauri::command]
pub async fn core_apply_sync_delta_v2(
    app: AppHandle,
    state: State<'_, CoreState>,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    let sync_until = state.sync_writes_until.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        apply_sync_delta_v2_impl(&base, &suppressed, &sync_until, input)
    })
    .await
    .map_err(task_join_err)?
}


fn map_notify_event(event: &Event) -> Option<&'static str> {
    match event.kind {
        EventKind::Create(_) => Some("add"),
        // Ignore metadata-only changes (atime, permissions) — they don't affect
        // note content and on iOS/macOS kqueue fires these spuriously.
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(_) => Some("change"),
        EventKind::Remove(_) => Some("unlink"),
        _ => None,
    }
}

/// Thin command to set file mtime — plugin-fs does not support setting mtime,
/// so this remains a Rust command used by writeNote and sync.
#[tauri::command]
pub async fn fs_set_mtime(app: AppHandle, path: String, mtime_ms: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let target = std::path::Path::new(&path);
        // Ensure the target path is under the notes root to prevent arbitrary mtime writes.
        let canonical_base = base.canonicalize().map_err(io_err_to_string)?;
        let canonical_target = target.canonicalize().map_err(io_err_to_string)?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err("path outside notes directory".to_string());
        }
        set_file_mtime_ms(target, mtime_ms)
    })
    .await
    .map_err(task_join_err)?
}


const ALLOWED_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
];

fn validate_image_ext(ext: &str) -> Result<String, String> {
    if ext.len() > 10 {
        return Err("image extension too long".to_string());
    }
    if ext.contains('/') || ext.contains('\\') || ext.contains("..") || ext.contains('\0') {
        return Err("image extension contains invalid characters".to_string());
    }
    let lower = ext.to_lowercase();
    if !ALLOWED_IMAGE_EXTS.contains(&lower.as_str()) {
        return Err(format!("disallowed image extension: {lower}"));
    }
    Ok(lower)
}

fn write_image_to_notes(base: &Path, data: &[u8], ext: &str) -> Result<String, String> {
    let ext = validate_image_ext(ext)?;
    let filename = format!("{}-{}.{}", now_ms(), rand_suffix(), ext);
    let dest = base.join(&filename);
    fs::write(dest, data).map_err(io_err_to_string)?;
    Ok(filename)
}

#[tauri::command]
pub async fn fs_save_image(app: AppHandle, source_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let source = PathBuf::from(&source_path);
        let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
        let ext = validate_image_ext(ext)?;
        let data = fs::read(&source).map_err(io_err_to_string)?;
        write_image_to_notes(&base, &data, &ext)
    })
    .await
    .map_err(task_join_err)?
}

/// Read an image from the native clipboard and save as PNG.
/// Used on Linux/Wayland where WebKitGTK gives empty clipboardData to JS.
#[tauri::command]
pub async fn fs_paste_clipboard_image(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let image = app.clipboard().read_image().map_err(|e| format!("Clipboard read failed: {e}"))?;
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            return Err("No image in clipboard".to_string());
        }
        let mut png_buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_buf, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("PNG header error: {e}"))?;
            writer
                .write_image_data(image.rgba())
                .map_err(|e| format!("PNG write error: {e}"))?;
        }
        let base = notes_root(&app)?;
        write_image_to_notes(&base, &png_buf, "png")
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_start_watcher(app: AppHandle, state: State<'_, CoreState>) -> Result<(), String> {
    let watcher_state = state.watcher.clone();
    let suppressed_watcher_events = state.suppressed_watcher_events.clone();
    let sync_writes_until = state.sync_writes_until.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = watcher_state
            .lock()
            .map_err(|_| "watcher lock poisoned".to_string())?;
        if guard.is_some() {
            return Ok(());
        }

        let base = notes_root(&app)?;
        let app_handle = app.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let Ok(event) = res else {
                    return;
                };
                let Some(change_type) = map_notify_event(&event) else {
                    return;
                };
                for path in event.paths {
                    let Some(filename) = path.file_name().and_then(|p| p.to_str()) else {
                        continue;
                    };
                    let lower = filename.to_lowercase();
                    if !lower.ends_with(".md") && !lower.ends_with(".txt") {
                        continue;
                    }
                    if sync_writes_until.load(Ordering::Acquire) > now_ms() {
                        continue;
                    }
                    let should_suppress = if let Ok(mut map) = suppressed_watcher_events.lock() {
                        let now = now_ms();
                        map.retain(|_, expiry| *expiry > now);
                        map.contains_key(filename)
                    } else {
                        false
                    };
                    if should_suppress {
                        continue;
                    }
                    let _ = app_handle.emit(
                        "fs:change",
                        serde_json::json!({
                            "type": change_type,
                            "filename": filename,
                        }),
                    );
                }
            },
            NotifyConfig::default(),
        )
        .map_err(|err| err.to_string())?;

        watcher
            .watch(&base, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;

        *guard = Some(watcher);
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn notes_dir_override_load(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(load_notes_dir_override(&app).map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn notes_dir_override_save(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_notes_dir_override(&app, dir.as_deref())
    })
    .await
    .map_err(task_join_err)?
}

/// Resolves the default notes root, honoring the STONEFRUIT_DATA_DIR env var
/// used to isolate per-worktree dev and cross-platform test runs. The webview
/// cannot read process env, so the TypeScript path layer delegates here.
#[tauri::command]
pub async fn resolve_default_notes_root(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = default_notes_root(&app)?;
        Ok(root.to_string_lossy().to_string())
    })
    .await
    .map_err(task_join_err)?
}

fn rand_suffix() -> String {
    let n = now_ms().unsigned_abs() % 10_000;
    format!("{n:04}")
}

// ---------------------------------------------------------------------------
// On-device inference — dev-only smoke test
// ---------------------------------------------------------------------------
//
// `inference_test_embed` exists so we can drive the ORT + tokenizer pipeline
// on a real device without any UI scaffolding. It synchronously downloads the
// model on first call (~35 MB + tokenizer.json), loads an `Embedder`, and
// returns a small metrics struct the test hook consumes.
//
// Available on all platforms: desktop (download-binaries), Android
// (load-dynamic + XNNPACK), iOS (xcframework + CoreML).
// We don't bother with a `debug_assertions` gate because Tauri 2.10's
// `generate_handler!` doesn't reliably honor `#[cfg]` attributes on
// individual command identifiers — once the dev-UI lands in Phase 5
// we'll remove this smoke-test command entirely.
mod inference_dev {
    use std::path::PathBuf;
    use std::time::Instant;

    use serde::Serialize;
    use tauri::{AppHandle, Manager};

    use stonefruit_inference::{
        download_to, DownloadTarget, Embedder, NOMIC_V15_DIMS, NOMIC_V15_MODEL_URL,
        NOMIC_V15_TOKENIZER_URL,
    };

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct InferenceTestResult {
        pub load_ms: u64,
        pub embed_ms: u64,
        pub dims: usize,
        /// First 8 components of the output vector. Just enough to eyeball
        /// that the output isn't all zeros / NaN without flooding the log.
        pub first_eight: Vec<f32>,
        pub model_path: String,
    }

    fn inference_dir(app: &AppHandle) -> Result<PathBuf, String> {
        // Reuse the notes-dir-override + app_data_dir resolution the rest of
        // `core.rs` uses, but fall back to the raw app_data_dir because the
        // inference cache is a per-install concept, not tied to the notes
        // vault the user may have moved.
        if let Some(data_dir) = super::env_data_dir() {
            return Ok(data_dir.join("inference"));
        }
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(data.join("inference"))
    }

    /// Synchronously download the model + tokenizer if missing, load an
    /// Embedder, embed `text`, and return timing + first-8 dims. Blocks the
    /// caller — that's fine for a dev-only smoke test.
    #[tauri::command]
    pub async fn inference_test_embed(
        app: AppHandle,
        text: String,
    ) -> Result<InferenceTestResult, String> {
        // Offload the whole thing to a blocking thread: synchronous HTTP +
        // ORT session creation + inference would otherwise pin a tokio
        // worker for tens of seconds.
        tauri::async_runtime::spawn_blocking(move || {
            let dir = inference_dir(&app)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let model_path = dir.join("model_quantized.onnx");
            let tokenizer_path = dir.join("tokenizer.json");

            if !model_path.exists() {
                download_to(&DownloadTarget {
                    url: NOMIC_V15_MODEL_URL.into(),
                    dest: model_path.clone(),
                    sha256: None,
                })
                .map_err(|e| format!("model download: {e}"))?;
            }
            if !tokenizer_path.exists() {
                download_to(&DownloadTarget {
                    url: NOMIC_V15_TOKENIZER_URL.into(),
                    dest: tokenizer_path.clone(),
                    sha256: None,
                })
                .map_err(|e| format!("tokenizer download: {e}"))?;
            }

            let load_start = Instant::now();
            let mut embedder = Embedder::load(&model_path, &tokenizer_path, NOMIC_V15_DIMS)
                .map_err(|e| format!("embedder load: {e}"))?;
            let load_ms = load_start.elapsed().as_millis() as u64;

            let embed_start = Instant::now();
            let v = embedder
                .embed(&text)
                .map_err(|e| format!("embed: {e}"))?;
            let embed_ms = embed_start.elapsed().as_millis() as u64;

            let first_eight = v.iter().take(8).copied().collect();

            Ok(InferenceTestResult {
                load_ms,
                embed_ms,
                dims: v.len(),
                first_eight,
                model_path: model_path.display().to_string(),
            })
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
    }
}

pub use inference_dev::inference_test_embed;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_notes_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("futo-tauri-test-{}-{n}", now_ms()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn cleanup_temp_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    // Serialize env-var mutations to prevent flaky failures when tests run in parallel.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn env_data_dir_returns_none_when_unset() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(env_data_dir(), None);
    }

    #[test]
    fn env_data_dir_returns_path_when_set() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("STONEFRUIT_DATA_DIR", "/tmp/wt-test-data");
        let result = env_data_dir();
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(result, Some(PathBuf::from("/tmp/wt-test-data")));
    }

    #[test]
    fn override_file_resolves_to_env_data_dir() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("STONEFRUIT_DATA_DIR", "/tmp/wt-test-data");
        let expected = PathBuf::from("/tmp/wt-test-data").join(NOTES_DIR_OVERRIDE_FILE);
        let actual = env_data_dir().map(|d| d.join(NOTES_DIR_OVERRIDE_FILE));
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(actual, Some(expected));
    }

    #[test]
    fn default_notes_dir_resolves_to_env_data_dir_notes() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("STONEFRUIT_DATA_DIR", "/tmp/wt-test-data");
        let expected = PathBuf::from("/tmp/wt-test-data").join("notes");
        let actual = env_data_dir().map(|d| d.join("notes"));
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(actual, Some(expected));
    }


    // V1 sync tests removed — V1 protocol is dead code.
    // See git history for original tests.

    // ── F. Rust Chaos Tests ─────────────────────────────────────────────
    // (V1-dependent chaos tests removed; non-V1 tests preserved below)

    // ── Image extension validation ──────────────────────────────────

    #[test]
    fn validate_image_ext_accepts_allowed_extensions() {
        for ext in ALLOWED_IMAGE_EXTS {
            assert!(validate_image_ext(ext).is_ok(), "should accept {ext}");
        }
        // Case-insensitive
        assert_eq!(validate_image_ext("JPG").unwrap(), "jpg");
        assert_eq!(validate_image_ext("Png").unwrap(), "png");
    }

    #[test]
    fn validate_image_ext_rejects_non_image_extensions() {
        assert!(validate_image_ext("exe").is_err());
        assert!(validate_image_ext("sh").is_err());
        assert!(validate_image_ext("md").is_err());
        assert!(validate_image_ext("html").is_err());
        assert!(validate_image_ext("js").is_err());
    }

    #[test]
    fn validate_image_ext_rejects_path_traversal() {
        assert!(validate_image_ext("../../../etc/evil").is_err());
        assert!(validate_image_ext("..").is_err());
        assert!(validate_image_ext("jpg/../../etc/passwd").is_err());
        assert!(validate_image_ext("jpg\\..\\..\\evil").is_err());
    }

    #[test]
    fn validate_image_ext_rejects_null_bytes() {
        assert!(validate_image_ext("jpg\0exe").is_err());
        assert!(validate_image_ext("\0").is_err());
    }

    #[test]
    fn validate_image_ext_rejects_overlong() {
        assert!(validate_image_ext("abcdefghijk").is_err()); // 11 chars
    }

    #[test]
    fn write_image_to_notes_rejects_bad_ext() {
        let base = temp_notes_dir();
        let data = b"fake image bytes";
        assert!(write_image_to_notes(&base, data, "exe").is_err());
        assert!(write_image_to_notes(&base, data, "../../../etc/evil").is_err());
        // Ensure no file was written
        let files: Vec<_> = fs::read_dir(&base).unwrap().collect();
        assert!(
            files.is_empty(),
            "no files should be written for rejected extensions"
        );
        cleanup_temp_dir(&base);
    }

    #[test]
    fn write_image_to_notes_accepts_valid_ext() {
        let base = temp_notes_dir();
        let data = b"fake image bytes";
        let filename = write_image_to_notes(&base, data, "jpg").unwrap();
        assert!(filename.ends_with(".jpg"));
        assert!(base.join(&filename).exists());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn hash_sha256_bytes_correct() {
        let data = b"hello world";
        let hash = hash_sha256_bytes(data);
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }


}

