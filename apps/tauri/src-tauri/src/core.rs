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
use futo_notes_core::files::{file_mtime_ms, safe_note_path};
#[cfg(test)]
use futo_notes_core::files::set_file_mtime_ms;
#[cfg(test)]
use futo_notes_core::hash::hash_sha256_bytes;
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

pub(crate) use futo_notes_core::files::{now_ms, write_atomic_text};

#[derive(Default)]
pub struct CoreState {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    pub(crate) suppressed_watcher_events: Arc<Mutex<HashMap<String, i64>>>,
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

/// Register `filename` (a relative path under the notes root, e.g. `Specs/foo.md`)
/// so the next `fs:change` the watcher sees for it is swallowed by
/// `emit_fs_change` / `emit_fs_rename`. This is how a Rust-driven write
/// (sync apply, note CRUD) avoids echoing back to the UI as an "external"
/// change and double-refreshing the list. Factored out so both the
/// sync-apply path and `notes.rs` share one definition.
pub(crate) fn suppress_filename(suppressed: &Arc<Mutex<HashMap<String, i64>>>, filename: &str) {
    if let Ok(mut map) = suppressed.lock() {
        let now = now_ms();
        map.insert(filename.to_string(), now + WATCHER_SUPPRESSION_MS);
        map.retain(|_, expiry| *expiry > now);
    }
}

/// One-shot suppression check for a single watcher echo: drops expired
/// entries, then if `rel_path` has a live suppression entry, REMOVES it and
/// returns `true`. This means each registered self-write swallows exactly
/// ONE echo (our own write's watcher event); a subsequent EXTERNAL change to
/// the same path is a distinct event that finds no entry and is delivered
/// normally. Without consuming, a 5s TTL entry would also eat an external
/// edit that lands inside the window (the external-watcher regression).
fn consume_suppression(suppressed: &Arc<Mutex<HashMap<String, i64>>>, rel_path: &str) -> bool {
    if let Ok(mut map) = suppressed.lock() {
        let now = now_ms();
        map.retain(|_, expiry| *expiry > now);
        map.remove(rel_path).is_some()
    } else {
        false
    }
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

/// Walk up from `path` removing empty directories until we hit `base` or
/// a non-empty directory. Skips removal of `base` itself.
pub(crate) fn prune_empty_parent_dirs(base: &Path, path: &Path) {
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
/// path is not under `base`, has no `.md` extension, or sits inside any
/// hidden directory (`.git`, `.obsidian`, etc.) — mirrors the
/// `filter_entry` skip used by `fs_list_notes_with_meta_impl` so the
/// watcher doesn't emit events for files the indexer ignored.
fn relative_md_path(base: &Path, path: &Path) -> Option<String> {
    let stripped = path.strip_prefix(base).ok()?;
    relative_md_path_stripped(stripped)
}

/// `relative_md_path` against multiple candidate spellings of the watch root,
/// returning the first that strips. The watcher needs BOTH the canonical and
/// the raw base: macOS FSEvents reports event paths under the canonical
/// prefix (`/private/var/...`) regardless of how the dir was registered,
/// while Linux inotify reports them under the registered (raw, possibly
/// symlinked) spelling. Stripping against only one of the two silently drops
/// every event on the other platform when the notes root sits behind a
/// symlink.
fn relative_md_path_any(bases: &[PathBuf], path: &Path) -> Option<String> {
    bases.iter().find_map(|base| relative_md_path(base, path))
}

fn relative_md_path_stripped(stripped: &Path) -> Option<String> {
    let s = stripped.to_str()?;
    if !s.ends_with(".md") && !s.ends_with(".txt") {
        return None;
    }
    // Reject anything under a hidden directory (or a hidden file itself).
    // Each path component is checked: `.git/HEAD.md` → skip,
    // `Specs/.draft.md` → skip, `Specs/folder.md` → keep.
    for component in s.split(|c: char| c == '/' || c == '\\') {
        if component.starts_with('.') {
            return None;
        }
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

pub(crate) fn fs_list_notes_with_meta_impl(base: &Path) -> Result<Vec<NoteFileMeta>, String> {
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
    if consume_suppression(suppressed, rel_path) {
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
    // Hold the lock across both checks so a concurrent retain/insert
    // can't make from/to disagree about whether the rename should be
    // suppressed (TOCTOU between two separate `lock()` calls). One-shot:
    // a self-rename's echo consumes BOTH the from and to entries so a
    // later external edit to either path is delivered normally.
    let suppress = if let Ok(mut map) = suppressed.lock() {
        let now = now_ms();
        map.retain(|_, expiry| *expiry > now);
        let has_from = map.contains_key(from);
        let has_to = map.contains_key(to);
        if has_from && has_to {
            map.remove(from);
            map.remove(to);
            true
        } else {
            false
        }
    } else {
        false
    };
    if suppress {
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
        // Strip event paths against BOTH spellings of the watch root. macOS
        // FSEvents reports paths under the canonical prefix (`/private/var/…`)
        // even when the dir was registered via its symlinked path (`/var/…`);
        // Linux inotify reports them under the registered raw spelling. Keeping
        // only one prefix silently drops every event on the other platform
        // when the notes root sits behind a symlink — see relative_md_path_any.
        let watch_bases: Vec<PathBuf> = {
            let mut v = Vec::with_capacity(2);
            if let Ok(canonical) = base.canonicalize() {
                v.push(canonical);
            }
            if !v.contains(&base) {
                v.push(base.clone());
            }
            v
        };
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
                            if let Some(rel) = relative_md_path_any(&watch_bases, &p.from_path) {
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
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "unlink",
                                    &rel,
                                );
                            }
                        }
                        for path in paths_iter {
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
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
                                let from_rel = relative_md_path_any(&watch_bases, &from);
                                let to_rel = relative_md_path_any(&watch_bases, &to);
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
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
                                emit_fs_change(
                                    &app_handle,
                                    &suppressed_watcher_events,
                                    "add",
                                    &rel,
                                );
                            }
                        }
                        for path in paths_iter {
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
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
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
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
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
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
                            if let Some(rel) = relative_md_path_any(&watch_bases, &path) {
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

/// Pure decision: can the running desktop install apply an in-app update?
///
/// On Linux only an AppImage self-updates in-app — deb/rpm are expected to
/// update via the system package repo, not the updater (a deb/rpm install
/// fed an AppImage artifact would fail at install time). macOS and Windows
/// installs always self-update. Anything else (incl. mobile) cannot.
pub(crate) fn compute_self_update_supported(os: &str, appimage_present: bool) -> bool {
    match os {
        "linux" => appimage_present,
        "macos" | "windows" => true,
        _ => false,
    }
}

/// Whether the running install supports the in-app updater. The webview cannot
/// read process env, so the Settings "Updates" section asks here before showing
/// the "Check for updates" button — keeping it hidden on deb/rpm installs where
/// in-app update is out of scope.
#[tauri::command]
pub fn app_self_update_supported() -> bool {
    // Debug builds (cargo-run dev, ANY OS) never self-update: they aren't packaged
    // updater artifacts, and a dev build must not auto-check the production
    // endpoint. On Linux this also follows from APPIMAGE being unset, but macOS/
    // Windows dev builds need this explicit gate.
    if cfg!(debug_assertions) {
        return false;
    }
    compute_self_update_supported(std::env::consts::OS, std::env::var("APPIMAGE").is_ok())
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

    #[test]
    fn consume_suppression_is_one_shot() {
        // A self-write registers one suppression entry. The first matching
        // watcher echo (our own write) is swallowed; a second event for the
        // SAME path (an external edit inside the 5s window) is delivered.
        let suppressed: Arc<Mutex<HashMap<String, i64>>> = Arc::new(Mutex::new(HashMap::new()));
        suppress_filename(&suppressed, "watch clean.md");

        // First echo: suppressed (consumes the entry).
        assert!(consume_suppression(&suppressed, "watch clean.md"));
        // Entry is gone immediately, before TTL expiry.
        assert!(suppressed.lock().unwrap().is_empty());
        // Second event for the same path: delivered (not suppressed).
        assert!(!consume_suppression(&suppressed, "watch clean.md"));
    }

    #[test]
    fn consume_suppression_unregistered_path_is_delivered() {
        let suppressed: Arc<Mutex<HashMap<String, i64>>> = Arc::new(Mutex::new(HashMap::new()));
        suppress_filename(&suppressed, "mine.md");
        // An event for a path we never registered is never suppressed,
        // and it does not consume the unrelated registered entry.
        assert!(!consume_suppression(&suppressed, "other.md"));
        assert!(consume_suppression(&suppressed, "mine.md"));
    }

    #[test]
    fn consume_suppression_drops_expired_entries() {
        // Manually insert an already-expired entry; it must not suppress.
        let suppressed: Arc<Mutex<HashMap<String, i64>>> = Arc::new(Mutex::new(HashMap::new()));
        suppressed
            .lock()
            .unwrap()
            .insert("stale.md".to_string(), now_ms() - 1);
        assert!(!consume_suppression(&suppressed, "stale.md"));
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

    // The watcher canonicalizes its base before stripping event paths because
    // macOS FSEvents reports paths under the canonical prefix (e.g.
    // `/private/var/...`) even when the dir was watched via its symlinked form
    // (`/var/...`). If the base is NOT canonicalized, `strip_prefix` fails for
    // every event and the watcher silently delivers nothing. This guards that
    // a canonical base + canonical event path strips, while a symlinked base +
    // canonical event path does NOT — proving why the canonicalize step matters.
    #[test]
    fn relative_md_path_requires_matching_prefix_canonicalization() {
        let base = temp_notes_dir();
        let canonical_base = base.canonicalize().unwrap();
        let event_path = canonical_base.join("note.md");

        // Canonical base vs canonical event path → strips fine.
        assert_eq!(
            relative_md_path(&canonical_base, &event_path).as_deref(),
            Some("note.md")
        );

        // A base with an extra `foo/..` component that resolves to the same dir
        // but is NOT byte-identical fails the lexical strip — the watcher must
        // canonicalize its base so this mismatch never occurs at runtime.
        let noncanonical_base = base.join("foo").join("..");
        assert_eq!(relative_md_path(&noncanonical_base, &event_path), None);

        cleanup_temp_dir(&base);
    }

    // The watcher strips against BOTH the canonical and the raw base spelling:
    // macOS FSEvents reports event paths under the canonical prefix, but Linux
    // inotify reports them under the registered (raw) spelling. With only the
    // canonical base, a symlinked notes root on Linux drops every event; with
    // only the raw base, macOS does. relative_md_path_any must accept either.
    #[test]
    fn relative_md_path_any_accepts_canonical_and_raw_spellings() {
        let base = temp_notes_dir();
        let canonical_base = base.canonicalize().unwrap();
        // A raw spelling that resolves to the same dir but is not
        // byte-identical (stands in for a symlinked root).
        let raw_base = base.join("foo").join("..");
        let bases = vec![canonical_base.clone(), raw_base.clone()];

        // Event reported under the canonical prefix (macOS FSEvents).
        assert_eq!(
            relative_md_path_any(&bases, &canonical_base.join("note.md")).as_deref(),
            Some("note.md")
        );
        // Event reported under the raw prefix (Linux inotify).
        assert_eq!(
            relative_md_path_any(&bases, &raw_base.join("note.md")).as_deref(),
            Some("note.md")
        );
        // Unrelated path still rejected.
        assert_eq!(
            relative_md_path_any(&bases, Path::new("/elsewhere/note.md")),
            None
        );

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
    fn self_update_supported_by_platform() {
        // Linux: only AppImage self-updates; deb/rpm (no APPIMAGE env) cannot.
        assert!(compute_self_update_supported("linux", true));
        assert!(!compute_self_update_supported("linux", false));
        // macOS + Windows installs always self-update.
        assert!(compute_self_update_supported("macos", false));
        assert!(compute_self_update_supported("windows", false));
        // Anything else (e.g. mobile) cannot.
        assert!(!compute_self_update_supported("android", false));
        assert!(!compute_self_update_supported("ios", false));
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
