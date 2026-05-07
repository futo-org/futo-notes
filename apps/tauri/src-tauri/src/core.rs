use notify::{
    event::{ModifyKind, RenameMode},
    Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use futo_notes_core::files::{file_mtime_ms, safe_note_path, set_file_mtime_ms};
#[cfg(test)]
use futo_notes_core::hash::hash_sha256_bytes;
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

pub(crate) use futo_notes_core::files::{now_ms, write_atomic_text};

#[derive(Default)]
pub struct CoreState {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    suppressed_watcher_events: Arc<Mutex<HashMap<String, i64>>>,
    /// Pending rename "From" events keyed by the OS-provided tracker cookie.
    /// `notify` emits Name(RenameMode::From) and ::To as a pair sharing one
    /// cookie when an entry is renamed in place. We hold the From for a
    /// short window and emit a single `rename` event when its To partner
    /// lands; an unmatched From after the window flushes as a delete.
    pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
}

struct PendingRename {
    from_path: PathBuf,
    inserted_at: i64,
}

const RENAME_PAIR_TIMEOUT_MS: i64 = 500;

const WATCHER_SUPPRESSION_MS: i64 = 5_000;

const NOTES_DIR_OVERRIDE_FILE: &str = "notes-dir-override.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NotesDirOverride {
    notes_dir: Option<String>,
}

/// Returns the custom data directory set via FUTO_NOTES_DATA_DIR env var, if present.
/// Used to redirect app data to a per-worktree isolated directory during development.
fn env_data_dir() -> Option<PathBuf> {
    std::env::var("FUTO_NOTES_DATA_DIR").ok().map(PathBuf::from)
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
    //    or via `FUTO_NOTES_DATA_DIR` for per-worktree test isolation.
    #[cfg(debug_assertions)]
    {
        let docs = app
            .path()
            .document_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| e.to_string())?;
        return Ok(docs.join("fake-notes"));
    }

    // 3. Release default: ~/Documents/futo-notes.
    #[cfg(not(debug_assertions))]
    {
        let docs = app
            .path()
            .document_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| e.to_string())?;
        Ok(docs.join("futo-notes"))
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

/// Validate that `rel` is a safe relative path under the notes root: no
/// absolute roots, no `..` traversal, no empty components, must end in
/// `.md`. Returns the validated joined path.
fn safe_relative_md_path(base: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("empty path".into());
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err("invalid relative path".into());
    }
    let mut path = base.to_path_buf();
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("invalid path component".into());
        }
        path.push(component);
    }
    if !normalized.ends_with(".md") {
        return Err("path must end in .md".into());
    }
    Ok(path)
}

fn apply_sync_delta_v2_impl(
    base: &Path,
    suppressed_watcher_events: &Arc<Mutex<HashMap<String, i64>>>,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let started = Instant::now();

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
        let path = match safe_relative_md_path(base, filename) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let _ = fs::remove_file(&path);
        // Best-effort: prune now-empty parent folders so the sidebar
        // doesn't keep ghost folders after a peer-driven note delete.
        prune_empty_parent_dirs(base, &path);
        deleted_filenames.push(filename.clone());
    }

    // Write updates
    for update in &input.update {
        suppress_filename(&update.filename);
        let path = safe_relative_md_path(base, &update.filename)?;
        // write_atomic_text already calls fs::create_dir_all on the parent.
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
        let path = safe_relative_md_path(base, &conflict.filename)?;
        write_atomic_text(&path, &conflict.content)?;
        conflict_filenames.push(conflict.filename.clone());
    }

    // Correct local file mtimes from server-authoritative timestamps.
    // This fixes files that were already up-to-date (same hash) but had wrong mtimes.
    for (filename, server_mtime) in &input.timestamps {
        if *server_mtime > 0 {
            let path = match safe_relative_md_path(base, filename) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if let Ok(meta) = fs::metadata(&path) {
                if file_mtime_ms(&meta) != *server_mtime {
                    suppress_filename(filename);
                    let _ = set_file_mtime_ms(&path, *server_mtime);
                }
            }
        }
    }

    Ok(V2SyncApplyOutput {
        updated_filenames,
        deleted_filenames,
        conflict_filenames,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Walk up from `path` removing empty directories until we hit `base` or
/// a non-empty directory. Skips removal of `base` itself.
fn prune_empty_parent_dirs(base: &Path, path: &Path) {
    let mut cursor = match path.parent() {
        Some(p) => p.to_path_buf(),
        None => return,
    };
    loop {
        if cursor == base {
            return;
        }
        if !cursor.starts_with(base) {
            return;
        }
        match fs::read_dir(&cursor) {
            Ok(mut iter) => {
                if iter.next().is_some() {
                    return;
                }
            }
            Err(_) => return,
        }
        if fs::remove_dir(&cursor).is_err() {
            return;
        }
        let parent = match cursor.parent() {
            Some(p) => p.to_path_buf(),
            None => return,
        };
        cursor = parent;
    }
}

#[tauri::command]
pub async fn core_apply_sync_delta_v2(
    app: AppHandle,
    state: State<'_, CoreState>,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        apply_sync_delta_v2_impl(&base, &suppressed, input)
    })
    .await
    .map_err(task_join_err)?
}


/// Classify a notify event into a UI-facing change type. Rename events
/// are surfaced separately by the watcher loop using the cookie-pairing
/// buffer, so we treat them as None here and let the caller dispatch.
#[derive(Debug, PartialEq, Eq)]
enum MappedEvent {
    Add,
    Change,
    Unlink,
    /// Rename From — the watcher should hold this with its cookie.
    RenameFrom,
    /// Rename To — the watcher should pair this with a previously-seen From.
    RenameTo,
}

fn map_notify_event(event: &Event) -> Option<MappedEvent> {
    match &event.kind {
        EventKind::Create(_) => Some(MappedEvent::Add),
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(MappedEvent::RenameFrom),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => Some(MappedEvent::RenameTo),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => Some(MappedEvent::RenameTo),
        EventKind::Modify(_) => Some(MappedEvent::Change),
        EventKind::Remove(_) => Some(MappedEvent::Unlink),
        _ => None,
    }
}

/// Convert an absolute path inside `base` to the relative-path identifier
/// the JS layer uses (forward slashes, .md kept). Returns None if the
/// path is not under `base` or has no `.md` extension.
fn relative_md_path(base: &Path, path: &Path) -> Option<String> {
    let stripped = path.strip_prefix(base).ok()?;
    let s = stripped.to_str()?;
    if !s.ends_with(".md") && !s.ends_with(".txt") {
        return None;
    }
    // Normalize `\` to `/` for cross-platform consistency.
    Some(s.replace('\\', "/"))
}

/// One-shot recursive readdir+stat for `.md` files, sorted by mtime desc.
/// `name` is the relative path from the notes root (e.g. `Specs/foo.md`)
/// using forward slashes on every platform.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFileMeta {
    pub name: String,
    pub mtime_ms: i64,
    pub size_bytes: u64,
}

fn fs_list_notes_with_meta_impl(base: &Path) -> Result<Vec<NoteFileMeta>, String> {
    if !base.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<NoteFileMeta> = Vec::new();

    let walker = WalkDir::new(base)
        // Don't follow symlinks — see Spec §"Out of scope for v1: Symlinks".
        .follow_links(false)
        .max_depth(futo_notes_core::files::MAX_FOLDER_DEPTH + 2)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories — keep `.git`, `.obsidian`, etc. out
            // of the index and out of the watcher.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
        });

    for entry in walker.flatten() {
        let file_type = entry.file_type();
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let rel = match relative_md_path(base, path) {
            Some(r) if r.ends_with(".md") => r,
            _ => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(NoteFileMeta {
            name: rel,
            mtime_ms: file_mtime_ms(&meta),
            size_bytes: meta.len(),
        });
    }

    entries.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(entries)
}

#[tauri::command]
pub async fn fs_list_notes_with_meta(app: AppHandle) -> Result<Vec<NoteFileMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        fs_list_notes_with_meta_impl(&base)
    })
    .await
    .map_err(task_join_err)?
}

/// Atomic write + optional mtime override + post-write mtime readback, in one IPC.
fn fs_write_note_atomic_impl(
    base: &Path,
    id: &str,
    content: &str,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    let path = safe_note_path(base, id)?;
    write_atomic_text(&path, content)?;
    if let Some(ms) = modified_at_ms {
        if ms >= 0 {
            let _ = set_file_mtime_ms(&path, ms);
        }
    }
    let meta = fs::metadata(&path).map_err(io_err_to_string)?;
    Ok(file_mtime_ms(&meta))
}

#[tauri::command]
pub async fn fs_write_note_atomic(
    app: AppHandle,
    id: String,
    content: String,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        fs_write_note_atomic_impl(&base, &id, &content, modified_at_ms)
    })
    .await
    .map_err(task_join_err)?
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

/// Emit a single `fs:change` event for a relative path under the notes
/// root. `change_type` is one of "add", "change", "unlink".
fn emit_fs_change(
    app: &AppHandle,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    change_type: &str,
    rel_path: &str,
) {
    if rel_path.is_empty() {
        return;
    }
    let lower = rel_path.to_lowercase();
    if !lower.ends_with(".md") && !lower.ends_with(".txt") {
        return;
    }
    let should_suppress = if let Ok(mut map) = suppressed.lock() {
        let now = now_ms();
        map.retain(|_, expiry| *expiry > now);
        map.contains_key(rel_path)
    } else {
        false
    };
    if should_suppress {
        return;
    }
    let _ = app.emit(
        "fs:change",
        serde_json::json!({
            "type": change_type,
            "filename": rel_path,
        }),
    );
}

/// Emit a `fs:change` rename event with from/to relative paths.
fn emit_fs_rename(
    app: &AppHandle,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    from: &str,
    to: &str,
) {
    let suppress_from = if let Ok(mut map) = suppressed.lock() {
        let now = now_ms();
        map.retain(|_, expiry| *expiry > now);
        map.contains_key(from)
    } else {
        false
    };
    let suppress_to = if let Ok(map) = suppressed.lock() {
        map.contains_key(to)
    } else {
        false
    };
    if suppress_from && suppress_to {
        return;
    }
    let _ = app.emit(
        "fs:change",
        serde_json::json!({
            "type": "rename",
            "filename": to,
            "from": from,
        }),
    );
}

#[tauri::command]
pub async fn fs_start_watcher(app: AppHandle, state: State<'_, CoreState>) -> Result<(), String> {
    let watcher_state = state.watcher.clone();
    let suppressed_watcher_events = state.suppressed_watcher_events.clone();
    let pending_renames = state.pending_renames.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = watcher_state
            .lock()
            .map_err(|_| "watcher lock poisoned".to_string())?;
        if guard.is_some() {
            return Ok(());
        }

        let base = notes_root(&app)?;
        let app_handle = app.clone();
        let watch_base = base.clone();
        let pending_for_handler = pending_renames.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, _>| {
                let Ok(event) = res else {
                    return;
                };
                let Some(mapped) = map_notify_event(&event) else {
                    return;
                };

                // Sweep stale pending-renames into deletes so an isolated
                // From event without a matching To still gets to the UI.
                if let Ok(mut pending) = pending_for_handler.lock() {
                    let now = now_ms();
                    let stale: Vec<u128> = pending
                        .iter()
                        .filter_map(|(k, v)| {
                            if now - v.inserted_at > RENAME_PAIR_TIMEOUT_MS {
                                Some(*k)
                            } else {
                                None
                            }
                        })
                        .collect();
                    for cookie in stale {
                        if let Some(p) = pending.remove(&cookie) {
                            if let Some(rel) = relative_md_path(&watch_base, &p.from_path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "unlink",
                                    &rel,
                                );
                            }
                        }
                    }
                }

                match mapped {
                    MappedEvent::RenameFrom => {
                        let cookie = event.attrs.tracker();
                        let mut paths_iter = event.paths.into_iter();
                        let first = paths_iter.next();
                        if let (Some(c), Some(path)) = (cookie, first.clone()) {
                            if let Ok(mut pending) = pending_for_handler.lock() {
                                pending.insert(
                                    c as u128,
                                    PendingRename {
                                        from_path: path,
                                        inserted_at: now_ms(),
                                    },
                                );
                            }
                            return;
                        }
                        // No cookie / no path: best-effort treat as delete.
                        if let Some(path) = first {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "unlink",
                                    &rel,
                                );
                            }
                        }
                        for path in paths_iter {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "unlink",
                                    &rel,
                                );
                            }
                        }
                    }
                    MappedEvent::RenameTo => {
                        let cookie = event.attrs.tracker();
                        let mut paths_iter = event.paths.into_iter();
                        let to_path = paths_iter.next();
                        if let (Some(c), Some(to)) = (cookie, to_path.clone()) {
                            let from_path = if let Ok(mut pending) = pending_for_handler.lock() {
                                pending.remove(&(c as u128)).map(|p| p.from_path)
                            } else {
                                None
                            };
                            if let Some(from) = from_path {
                                let from_rel = relative_md_path(&watch_base, &from);
                                let to_rel = relative_md_path(&watch_base, &to);
                                match (from_rel, to_rel) {
                                    (Some(f), Some(t)) => emit_fs_rename(
                                        &app_handle,
                                        &suppressed_watcher_events,
                                        &f,
                                        &t,
                                    ),
                                    (Some(f), None) => emit_fs_change(
                                        &app_handle,
                                        &suppressed_watcher_events,
                                        "unlink",
                                        &f,
                                    ),
                                    (None, Some(t)) => emit_fs_change(
                                        &app_handle,
                                        &suppressed_watcher_events,
                                        "add",
                                        &t,
                                    ),
                                    _ => {}
                                }
                                return;
                            }
                        }
                        if let Some(path) = to_path {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "add",
                                    &rel,
                                );
                            }
                        }
                        for path in paths_iter {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "add",
                                    &rel,
                                );
                            }
                        }
                    }
                    MappedEvent::Add => {
                        for path in event.paths {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "add",
                                    &rel,
                                );
                            }
                        }
                    }
                    MappedEvent::Change => {
                        for path in event.paths {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "change",
                                    &rel,
                                );
                            }
                        }
                    }
                    MappedEvent::Unlink => {
                        for path in event.paths {
                            if let Some(rel) = relative_md_path(&watch_base, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "unlink",
                                    &rel,
                                );
                            }
                        }
                    }
                }
            },
            NotifyConfig::default(),
        )
        .map_err(|err| err.to_string())?;

        watcher
            .watch(&base, RecursiveMode::Recursive)
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

/// Resolves the default notes root, honoring the FUTO_NOTES_DATA_DIR env var
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

// ── Folder operations ──────────────────────────────────────────────────

/// Validate a relative folder path: each component is a valid filename,
/// no `.` / `..` / empty components, depth within the limit. Returns
/// the joined absolute path under `base`.
fn safe_folder_path(base: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("empty folder path".into());
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err("invalid folder path".into());
    }
    let components: Vec<&str> = normalized.split('/').collect();
    if components.len() > futo_notes_core::files::MAX_FOLDER_DEPTH {
        return Err("folder depth exceeded".into());
    }
    let mut path = base.to_path_buf();
    for c in &components {
        if c.is_empty() || *c == "." || *c == ".." {
            return Err("invalid folder component".into());
        }
        path.push(c);
    }
    Ok(path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
}

fn list_folders_impl(base: &Path) -> Result<Vec<FolderEntry>, String> {
    if !base.exists() {
        return Ok(Vec::new());
    }
    let mut folders: Vec<FolderEntry> = Vec::new();
    let walker = WalkDir::new(base)
        .follow_links(false)
        .max_depth(futo_notes_core::files::MAX_FOLDER_DEPTH + 1)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
        });
    for entry in walker.flatten() {
        if !entry.file_type().is_dir() || entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let stripped = match path.strip_prefix(base).ok().and_then(|p| p.to_str()) {
            Some(s) => s.replace('\\', "/"),
            None => continue,
        };
        folders.push(FolderEntry { path: stripped });
    }
    folders.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(folders)
}

#[tauri::command]
pub async fn fs_list_folders(app: AppHandle) -> Result<Vec<FolderEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        list_folders_impl(&base)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_create_folder(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let target = safe_folder_path(&base, &path)?;
        // Case-sensitive sibling collision: refuse to create if any sibling
        // matches case-insensitively.
        if let (Some(parent), Some(leaf)) = (target.parent(), target.file_name()) {
            let leaf_lc = leaf.to_string_lossy().to_lowercase();
            if let Ok(read) = fs::read_dir(parent) {
                for entry in read.flatten() {
                    if entry.path() == target {
                        continue;
                    }
                    let n = entry.file_name();
                    if n.to_string_lossy().to_lowercase() == leaf_lc {
                        return Err(format!(
                            "A folder named \"{}\" already exists at this level",
                            n.to_string_lossy()
                        ));
                    }
                }
            }
        }
        fs::create_dir_all(&target).map_err(io_err_to_string)?;
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_rename_folder(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let from_abs = safe_folder_path(&base, &from)?;
        let to_abs = safe_folder_path(&base, &to)?;
        if !from_abs.exists() {
            return Err("source folder does not exist".into());
        }
        if to_abs.exists() {
            return Err("target folder already exists".into());
        }
        fs::rename(&from_abs, &to_abs).map_err(io_err_to_string)?;
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_delete_folder(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let target = safe_folder_path(&base, &path)?;
        if !target.exists() {
            return Ok(());
        }
        // Desktop: route through the system trash so users can recover.
        // Mobile: hard delete.
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            if let Err(err) = trash::delete(&target) {
                // Fall back to hard delete if trash isn't available
                // (e.g. headless CI without a desktop environment).
                eprintln!("[folder-delete] trash::delete failed: {err}; falling back to hard delete");
                fs::remove_dir_all(&target).map_err(io_err_to_string)?;
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            fs::remove_dir_all(&target).map_err(io_err_to_string)?;
        }
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_delete_note_to_trash(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_note_path(&base, &id)?;
        if !path.exists() {
            return Ok(());
        }
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            if let Err(err) = trash::delete(&path) {
                eprintln!("[note-delete] trash::delete failed: {err}; falling back to hard delete");
                fs::remove_file(&path).map_err(io_err_to_string)?;
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            fs::remove_file(&path).map_err(io_err_to_string)?;
        }
        prune_empty_parent_dirs(&base, &path);
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_move_note(
    app: AppHandle,
    from_id: String,
    to_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let from_abs = safe_note_path(&base, &from_id)?;
        let to_abs = safe_note_path(&base, &to_id)?;
        if !from_abs.exists() {
            return Err("source note does not exist".into());
        }
        if to_abs.exists() {
            return Err("target note already exists".into());
        }
        if let Some(parent) = to_abs.parent() {
            fs::create_dir_all(parent).map_err(io_err_to_string)?;
        }
        fs::rename(&from_abs, &to_abs).map_err(io_err_to_string)?;
        prune_empty_parent_dirs(&base, &from_abs);
        Ok(())
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

    use futo_notes_inference::{
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

/// Raise the soft keyboard / IME for the focused web view.
///
/// Mobile webviews don't always raise the IME for a programmatic
/// `.focus()` on a contenteditable. Both Android Chrome and iOS WKWebView
/// gate keyboard display on a real user gesture; in-app navigation that
/// auto-focuses the editor can leave the user staring at a focused field
/// with no keyboard. This command bridges to the platform IME so the
/// keyboard appears as soon as we focus the editor (e.g. after "+ New").
///
/// - **Android**: calls `InputMethodManager.showSoftInput(view, SHOW_IMPLICIT)`
///   via JNI.
/// - **iOS**: makes the WKWebView the first responder; the focused
///   contenteditable inside it then drives keyboard display.
/// - **Desktop**: no-op — physical keyboards don't need a hint.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn show_soft_keyboard(window: tauri::WebviewWindow) -> Result<(), String> {
    use jni::objects::JValue;

    window
        .with_webview(|webview| {
            let jni_handle = webview.jni_handle();
            jni_handle.exec(|env, activity, webview_obj| {
                let service_name = match env.new_string("input_method") {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let imm = match env
                    .call_method(
                        activity,
                        "getSystemService",
                        "(Ljava/lang/String;)Ljava/lang/Object;",
                        &[JValue::Object(&service_name)],
                    )
                    .and_then(|r| r.l())
                {
                    Ok(v) => v,
                    Err(_) => return,
                };
                // SHOW_IMPLICIT (1) — same flag the system uses when the
                // user taps an EditText. SHOW_FORCED can leave the IME up
                // after navigation, which we don't want.
                let _ = env.call_method(
                    &imm,
                    "showSoftInput",
                    "(Landroid/view/View;I)Z",
                    &[JValue::Object(webview_obj), JValue::Int(1)],
                );
            });
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn show_soft_keyboard(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|wv| {
            use objc2::msg_send;
            use objc2::runtime::{AnyObject, Bool};
            unsafe {
                let wk: *mut AnyObject = wv.inner().cast();
                if wk.is_null() {
                    return;
                }
                // becomeFirstResponder() on the WKWebView. The focused
                // contenteditable inside the webview drives actual keyboard
                // display — this just makes sure WK is in the responder
                // chain when JS calls .focus() outside a tap context.
                let _: Bool = msg_send![wk, becomeFirstResponder];
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn show_soft_keyboard() -> Result<(), String> {
    Ok(())
}

/// Trigger a tactile feedback "tap" on the device. iOS uses
/// `UIImpactFeedbackGenerator` (medium style); other platforms rely on
/// `navigator.vibrate` from the JS side and this command is a no-op so
/// callers don't have to platform-fork.
#[cfg(target_os = "ios")]
#[tauri::command]
pub fn haptic_impact(app: tauri::AppHandle) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // UIKit feedback generators must be instantiated and fired on the
    // main thread — `run_on_main_thread` returns immediately on the
    // calling thread, so the haptic dispatch doesn't block the IPC
    // round-trip and the JS caller stays responsive.
    app.run_on_main_thread(|| unsafe {
        let cls: *mut AnyObject = msg_send![objc2::class!(UIImpactFeedbackGenerator), alloc];
        // UIImpactFeedbackStyle.medium = 1
        let generator: *mut AnyObject = msg_send![cls, initWithStyle: 1isize];
        if generator.is_null() {
            return;
        }
        let _: () = msg_send![generator, prepare];
        let _: () = msg_send![generator, impactOccurred];
        let _: () = msg_send![generator, release];
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn haptic_impact() -> Result<(), String> {
    Ok(())
}

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
        std::env::remove_var("FUTO_NOTES_DATA_DIR");
        assert_eq!(env_data_dir(), None);
    }

    #[test]
    fn env_data_dir_returns_path_when_set() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("FUTO_NOTES_DATA_DIR", "/tmp/wt-test-data");
        let result = env_data_dir();
        std::env::remove_var("FUTO_NOTES_DATA_DIR");
        assert_eq!(result, Some(PathBuf::from("/tmp/wt-test-data")));
    }

    #[test]
    fn override_file_resolves_to_env_data_dir() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("FUTO_NOTES_DATA_DIR", "/tmp/wt-test-data");
        let expected = PathBuf::from("/tmp/wt-test-data").join(NOTES_DIR_OVERRIDE_FILE);
        let actual = env_data_dir().map(|d| d.join(NOTES_DIR_OVERRIDE_FILE));
        std::env::remove_var("FUTO_NOTES_DATA_DIR");
        assert_eq!(actual, Some(expected));
    }

    #[test]
    fn default_notes_dir_resolves_to_env_data_dir_notes() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("FUTO_NOTES_DATA_DIR", "/tmp/wt-test-data");
        let expected = PathBuf::from("/tmp/wt-test-data").join("notes");
        let actual = env_data_dir().map(|d| d.join("notes"));
        std::env::remove_var("FUTO_NOTES_DATA_DIR");
        assert_eq!(actual, Some(expected));
    }

    // V1 sync tests removed — V1 protocol is dead code.
    // See git history for original tests.

    // ── F. Rust Chaos Tests ─────────────────────────────────────────────
    // (V1-dependent chaos tests removed; non-V1 tests preserved below)

    // ── fs_list_notes_with_meta ─────────────────────────────────────

    #[test]
    fn fs_list_notes_with_meta_returns_empty_when_dir_missing() {
        let dir = temp_notes_dir();
        cleanup_temp_dir(&dir); // Remove it so the path doesn't exist
        let result = fs_list_notes_with_meta_impl(&dir).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn fs_list_notes_with_meta_returns_only_md_files() {
        let dir = temp_notes_dir();
        fs::write(dir.join("note1.md"), "a").unwrap();
        fs::write(dir.join("note2.md"), "b").unwrap();
        fs::write(dir.join("image.png"), b"\x89PNG").unwrap();
        fs::write(dir.join(".hidden"), "x").unwrap();

        let result = fs_list_notes_with_meta_impl(&dir).unwrap();
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"note1.md"));
        assert!(names.contains(&"note2.md"));
        cleanup_temp_dir(&dir);
    }

    // ── fs_write_note_atomic ────────────────────────────────────────

    #[test]
    fn fs_write_note_atomic_writes_and_returns_mtime() {
        let dir = temp_notes_dir();
        let mtime = fs_write_note_atomic_impl(&dir, "hello", "body text", None).unwrap();
        let path = dir.join("hello.md");
        assert!(path.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "body text");
        let disk_mtime = file_mtime_ms(&fs::metadata(&path).unwrap());
        assert_eq!(mtime, disk_mtime);
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn fs_write_note_atomic_honors_modified_at_override() {
        let dir = temp_notes_dir();
        let target_ms = 1_700_000_000_000_i64;
        let mtime = fs_write_note_atomic_impl(&dir, "stamped", "x", Some(target_ms)).unwrap();
        assert_eq!(mtime, target_ms);
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn fs_write_note_atomic_rejects_path_traversal() {
        let dir = temp_notes_dir();
        let err = fs_write_note_atomic_impl(&dir, "../escape", "nope", None);
        assert!(err.is_err());
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn fs_list_notes_with_meta_reports_size() {
        let dir = temp_notes_dir();
        fs::write(dir.join("short.md"), "hi").unwrap();
        fs::write(dir.join("long.md"), "a".repeat(1024)).unwrap();

        let result = fs_list_notes_with_meta_impl(&dir).unwrap();
        let by_name: std::collections::HashMap<&str, u64> =
            result.iter().map(|e| (e.name.as_str(), e.size_bytes)).collect();
        assert_eq!(by_name["short.md"], 2);
        assert_eq!(by_name["long.md"], 1024);
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn fs_list_notes_with_meta_sorts_by_mtime_desc() {
        let dir = temp_notes_dir();
        fs::write(dir.join("older.md"), "x").unwrap();
        fs::write(dir.join("newer.md"), "x").unwrap();
        set_file_mtime_ms(&dir.join("older.md"), 1_000_000_000_000).unwrap();
        set_file_mtime_ms(&dir.join("newer.md"), 2_000_000_000_000).unwrap();

        let result = fs_list_notes_with_meta_impl(&dir).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "newer.md");
        assert_eq!(result[1].name, "older.md");
        assert!(result[0].mtime_ms > result[1].mtime_ms);
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn fs_list_notes_with_meta_recurses_into_subdirectories() {
        let dir = temp_notes_dir();
        fs::write(dir.join("note.md"), "x").unwrap();
        fs::create_dir_all(dir.join("subfolder")).unwrap();
        fs::write(dir.join("subfolder").join("nested.md"), "x").unwrap();
        fs::create_dir_all(dir.join("a/b/c")).unwrap();
        fs::write(dir.join("a/b/c/deep.md"), "x").unwrap();

        let result = fs_list_notes_with_meta_impl(&dir).unwrap();
        let names: std::collections::HashSet<&str> =
            result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains("note.md"));
        assert!(names.contains("subfolder/nested.md"));
        assert!(names.contains("a/b/c/deep.md"));
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn fs_list_notes_with_meta_skips_dotfile_directories() {
        let dir = temp_notes_dir();
        fs::write(dir.join("note.md"), "x").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("ignored.md"), "x").unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::write(dir.join(".obsidian").join("config.md"), "x").unwrap();

        let result = fs_list_notes_with_meta_impl(&dir).unwrap();
        let names: std::collections::HashSet<&str> =
            result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains("note.md"));
        assert!(!names.iter().any(|n| n.starts_with(".git/")));
        assert!(!names.iter().any(|n| n.starts_with(".obsidian/")));
        cleanup_temp_dir(&dir);
    }

    // ── safe_relative_md_path ─────────────────────────────────────────

    #[test]
    fn safe_relative_md_path_accepts_nested() {
        let base = temp_notes_dir();
        let p = safe_relative_md_path(&base, "Specs/folder.md").unwrap();
        assert_eq!(p, base.join("Specs/folder.md"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn safe_relative_md_path_rejects_traversal() {
        let base = std::path::PathBuf::from("/tmp/test");
        assert!(safe_relative_md_path(&base, "../escape.md").is_err());
        assert!(safe_relative_md_path(&base, "a/../b.md").is_err());
        assert!(safe_relative_md_path(&base, "/abs.md").is_err());
        assert!(safe_relative_md_path(&base, "a//b.md").is_err());
    }

    #[test]
    fn safe_relative_md_path_requires_md() {
        let base = std::path::PathBuf::from("/tmp/test");
        assert!(safe_relative_md_path(&base, "foo.txt").is_err());
        assert!(safe_relative_md_path(&base, "foo").is_err());
    }

    // ── folder ops ─────────────────────────────────────────────────────

    #[test]
    fn safe_folder_path_accepts_nested() {
        let base = std::path::PathBuf::from("/tmp/test");
        let p = safe_folder_path(&base, "Specs/sub").unwrap();
        assert_eq!(p, base.join("Specs/sub"));
    }

    #[test]
    fn safe_folder_path_rejects_traversal() {
        let base = std::path::PathBuf::from("/tmp/test");
        assert!(safe_folder_path(&base, "..").is_err());
        assert!(safe_folder_path(&base, "a/..").is_err());
        assert!(safe_folder_path(&base, "/abs").is_err());
        assert!(safe_folder_path(&base, "a/").is_err());
    }

    #[test]
    fn list_folders_lists_directories() {
        let dir = temp_notes_dir();
        fs::create_dir_all(dir.join("Specs")).unwrap();
        fs::create_dir_all(dir.join("Specs/sub")).unwrap();
        fs::create_dir_all(dir.join("Other")).unwrap();
        fs::write(dir.join("note.md"), "x").unwrap();
        fs::write(dir.join("Specs/foo.md"), "x").unwrap();

        let folders = list_folders_impl(&dir).unwrap();
        let paths: Vec<&str> = folders.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"Specs"));
        assert!(paths.contains(&"Specs/sub"));
        assert!(paths.contains(&"Other"));
        cleanup_temp_dir(&dir);
    }

    #[test]
    fn relative_md_path_strips_base() {
        let base = temp_notes_dir();
        let p = base.join("Specs").join("foo.md");
        let rel = relative_md_path(&base, &p).unwrap();
        assert_eq!(rel, "Specs/foo.md");
        cleanup_temp_dir(&base);
    }

    #[test]
    fn prune_empty_parent_dirs_removes_chain() {
        let dir = temp_notes_dir();
        fs::create_dir_all(dir.join("a/b/c")).unwrap();
        let leaf = dir.join("a/b/c/note.md");
        fs::write(&leaf, "x").unwrap();
        fs::remove_file(&leaf).unwrap();
        prune_empty_parent_dirs(&dir, &leaf);
        assert!(!dir.join("a/b/c").exists());
        assert!(!dir.join("a/b").exists());
        assert!(!dir.join("a").exists());
        assert!(dir.exists());
        cleanup_temp_dir(&dir);
    }

    // ── Watcher event classification ────────────────────────────────

    #[test]
    fn map_notify_event_classifies_create_as_add() {
        let ev = Event::new(EventKind::Create(notify::event::CreateKind::File));
        assert_eq!(map_notify_event(&ev), Some(MappedEvent::Add));
    }

    #[test]
    fn map_notify_event_classifies_remove_as_unlink() {
        let ev = Event::new(EventKind::Remove(notify::event::RemoveKind::File));
        assert_eq!(map_notify_event(&ev), Some(MappedEvent::Unlink));
    }

    #[test]
    fn map_notify_event_classifies_metadata_changes_as_none() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Metadata(
            notify::event::MetadataKind::Permissions,
        )));
        assert_eq!(map_notify_event(&ev), None);
    }

    #[test]
    fn map_notify_event_classifies_modify_as_change() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content,
        )));
        assert_eq!(map_notify_event(&ev), Some(MappedEvent::Change));
    }

    #[test]
    fn map_notify_event_classifies_rename_from() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)));
        assert_eq!(map_notify_event(&ev), Some(MappedEvent::RenameFrom));
    }

    #[test]
    fn map_notify_event_classifies_rename_to() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)));
        assert_eq!(map_notify_event(&ev), Some(MappedEvent::RenameTo));
    }

    #[test]
    fn map_notify_event_classifies_rename_both_as_to() {
        // notify v8 uses Both for atomic rename pairs that fit in one event
        // (e.g. some Linux kernels). We treat it as the To half of a pair.
        let ev = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)));
        assert_eq!(map_notify_event(&ev), Some(MappedEvent::RenameTo));
    }

    #[test]
    fn prune_empty_parent_dirs_stops_at_nonempty() {
        let dir = temp_notes_dir();
        fs::create_dir_all(dir.join("a/b")).unwrap();
        fs::write(dir.join("a/keep.md"), "x").unwrap();
        let leaf = dir.join("a/b/note.md");
        fs::write(&leaf, "x").unwrap();
        fs::remove_file(&leaf).unwrap();
        prune_empty_parent_dirs(&dir, &leaf);
        assert!(!dir.join("a/b").exists());
        assert!(dir.join("a").exists());
        assert!(dir.join("a/keep.md").exists());
        cleanup_temp_dir(&dir);
    }

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

