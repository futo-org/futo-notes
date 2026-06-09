//! `#[tauri::command]` wrappers over the canonical note CRUD + scanning in
//! `futo-notes-model::crud` — the same domain logic native iOS/Android reach
//! through the `futo-notes-ffi` `NoteStore`. This is the Tauri adapter: it
//! consumes the crate directly, it never touches the UniFFI objects.
//!
//! The command set mirrors the FFI `NoteStore` method set 1:1, plus the
//! desktop-only folder ops + trash routing that previously lived in `core.rs`
//! (Phase 1 consolidates those onto the model so there is one path). Every
//! command wraps a testable `_impl` fn over `notes_root(&app)`, runs the
//! filesystem work in `spawn_blocking`, and returns `Result<_, String>`.
//!
//! Path safety is pushed DOWN: `model::crud` → `futo_notes_core::files`
//! (`safe_note_path` / `get_unique_note_id`), the same guards the FFI uses, so
//! traversal checks are not duplicated per command.
//!
//! Self-write suppression (the critical no-double-refresh discipline): every
//! mutation registers the touched relative filename(s) into
//! `CoreState.suppressed_watcher_events` BEFORE the disk write so the watcher
//! echo for our own write is swallowed by `core::emit_fs_change`. The
//! optimistic cache update in `notes.svelte.ts` is then the only refresh for a
//! local edit. This mirrors what the sync orchestrator's `apply_delta`
//! (`futo-notes-sync`) already does.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};

use futo_notes_core::files::safe_note_path;
use futo_notes_model as model;

use crate::core::{
    io_err_to_string, notes_root, prune_empty_parent_dirs, suppress_filename, task_join_err,
    CoreState,
};

/// One note's list-level metadata. Mirrors the FFI `NoteMetadata` but in
/// camelCase + the existing TS `NotePreview` field set, so `notesCache` feeds
/// with a tiny shim and zero remapping. `modifiedMs` maps to
/// `NotePreview.modificationTime`; `tags` are canonical lowercase, NO leading
/// `#`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub modified_ms: i64,
    pub preview: String,
    pub tags: Vec<String>,
}

impl From<model::NoteMetadata> for NoteMeta {
    fn from(m: model::NoteMetadata) -> Self {
        NoteMeta {
            id: m.id,
            title: m.title,
            folder: m.folder,
            modified_ms: m.modified_ms,
            preview: m.preview,
            tags: m.tags,
        }
    }
}

// ── scan / read ───────────────────────────────────────────────────────────

/// Scan all notes, sorted by mtime descending. One IPC returns the whole
/// vault's metadata (coarse by design — mirrors FFI `scan_notes`).
#[tauri::command]
pub async fn notes_scan(app: AppHandle) -> Result<Vec<NoteMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        Ok(model::scan_notes(&base).into_iter().map(Into::into).collect())
    })
    .await
    .map_err(task_join_err)?
}

/// All folder paths (note ancestors + empty dirs), sorted.
#[tauri::command]
pub async fn notes_scan_folders(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        Ok(model::scan_folders(&base))
    })
    .await
    .map_err(task_join_err)?
}

/// Read a note's content (`""` if missing).
#[tauri::command]
pub async fn notes_read(app: AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        Ok(model::read_note(&base, &id))
    })
    .await
    .map_err(task_join_err)?
}

/// Whether a note exists on disk.
#[tauri::command]
pub async fn notes_exists(app: AppHandle, id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        Ok(model::note_exists(&base, &id))
    })
    .await
    .map_err(task_join_err)?
}

// ── mutations ───────────────────────────────────────────────────────────

/// Atomic write + optional mtime override + post-write mtime readback, in one
/// IPC. Returns the resulting mtime (keeps the `fs_write_note_atomic`
/// readback contract that `platform/tauri.ts` depends on). Suppresses the
/// watcher echo for `{id}.md` before writing.
fn notes_write_impl(
    base: &Path,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    id: &str,
    content: &str,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    suppress_filename(suppressed, &format!("{id}.md"));
    let path = safe_note_path(base, id)?;
    model::write_note(base, id, content)?;
    if let Some(ms) = modified_at_ms {
        if ms >= 0 {
            let _ = futo_notes_core::files::set_file_mtime_ms(&path, ms);
        }
    }
    let meta = std::fs::metadata(&path).map_err(io_err_to_string)?;
    Ok(futo_notes_core::files::file_mtime_ms(&meta))
}

#[tauri::command]
pub async fn notes_write(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
    content: String,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_write_impl(&base, &suppressed, &id, &content, modified_at_ms)
    })
    .await
    .map_err(task_join_err)?
}

/// Create a note from a title (+ optional folder). Returns the final,
/// collision-resolved id.
fn notes_create_impl(
    base: &Path,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    title: &str,
    folder: &str,
) -> Result<String, String> {
    // create_note resolves the unique id internally; we can't know it before
    // the call, so suppress the resolved id's echo immediately after creation.
    // The write happens inside create_note; the watcher debounce (50ms) is well
    // inside the 5s suppression TTL, so registering right after is in time.
    let id = model::create_note(base, folder, title)?;
    suppress_filename(suppressed, &format!("{id}.md"));
    Ok(id)
}

#[tauri::command]
pub async fn notes_create(
    app: AppHandle,
    state: State<'_, CoreState>,
    title: String,
    folder: String,
) -> Result<String, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_create_impl(&base, &suppressed, &title, &folder)
    })
    .await
    .map_err(task_join_err)?
}

/// Hard-delete a note (missing is not an error). Does NOT prune empty parents
/// (matches the FFI / model `delete_note` contract; trash + pruning is the
/// `notes_delete_to_trash` desktop affordance).
fn notes_delete_impl(
    base: &Path,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    id: &str,
) -> Result<(), String> {
    suppress_filename(suppressed, &format!("{id}.md"));
    model::delete_note(base, id)
}

#[tauri::command]
pub async fn notes_delete(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
) -> Result<(), String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_delete_impl(&base, &suppressed, &id)
    })
    .await
    .map_err(task_join_err)?
}

/// Rename/move a note. Returns the final (collision-resolved) id. Suppresses
/// both old + new filename echoes.
fn notes_rename_impl(
    base: &Path,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    old_id: &str,
    new_id: &str,
) -> Result<String, String> {
    suppress_filename(suppressed, &format!("{old_id}.md"));
    suppress_filename(suppressed, &format!("{new_id}.md"));
    let final_id = model::rename_note(base, old_id, new_id)?;
    // The collision-resolved id may differ from new_id; suppress it too.
    if final_id != new_id {
        suppress_filename(suppressed, &format!("{final_id}.md"));
    }
    Ok(final_id)
}

#[tauri::command]
pub async fn notes_rename(
    app: AppHandle,
    state: State<'_, CoreState>,
    old_id: String,
    new_id: String,
) -> Result<String, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_rename_impl(&base, &suppressed, &old_id, &new_id)
    })
    .await
    .map_err(task_join_err)?
}

/// Move a note into `folder` (`""` = root), keeping its leaf. Returns the
/// final id. Suppresses both old + new filename echoes.
fn notes_move_impl(
    base: &Path,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    id: &str,
    folder: &str,
) -> Result<String, String> {
    suppress_filename(suppressed, &format!("{id}.md"));
    let final_id = model::move_note(base, id, folder)?;
    if final_id != id {
        suppress_filename(suppressed, &format!("{final_id}.md"));
    }
    Ok(final_id)
}

#[tauri::command]
pub async fn notes_move(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
    folder: String,
) -> Result<String, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_move_impl(&base, &suppressed, &id, &folder)
    })
    .await
    .map_err(task_join_err)?
}

/// Create a folder (+ intermediates). Returns the sanitized path (or `""`).
#[tauri::command]
pub async fn notes_create_folder(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        model::create_folder(&base, &path)
    })
    .await
    .map_err(task_join_err)?
}

// ── desktop-only affordances (NOT on the FFI surface) ──────────────────────
//
// These consolidate the equivalents previously in core.rs (`fs_delete_note_to_trash`,
// `fs_rename_folder`, `fs_delete_folder`) onto the model where the model
// covers the path, preserving trash routing on desktop / hard-delete on mobile.

/// Delete a note: routed through the system trash on desktop, hard-delete on
/// mobile. Prunes now-empty parent dirs. Suppresses the watcher echo.
fn notes_delete_to_trash_impl(
    base: &Path,
    suppressed: &Arc<Mutex<HashMap<String, i64>>>,
    id: &str,
) -> Result<(), String> {
    suppress_filename(suppressed, &format!("{id}.md"));
    let path = safe_note_path(base, id)?;
    if !path.exists() {
        return Ok(());
    }
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        if let Err(err) = trash::delete(&path) {
            eprintln!("[note-delete] trash::delete failed: {err}; falling back to hard delete");
            std::fs::remove_file(&path).map_err(io_err_to_string)?;
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        // Mobile hard-delete via the model (missing is not an error).
        model::delete_note(base, id)?;
    }
    prune_empty_parent_dirs(base, &path);
    Ok(())
}

#[tauri::command]
pub async fn notes_delete_to_trash(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
) -> Result<(), String> {
    let suppressed = state.suppressed_watcher_events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_delete_to_trash_impl(&base, &suppressed, &id)
    })
    .await
    .map_err(task_join_err)?
}

/// Rename/move a folder subtree. Sanitizes both paths via the model so a single
/// rule path governs folder names.
fn notes_rename_folder_impl(base: &Path, from: &str, to: &str) -> Result<(), String> {
    let from_clean = model::sanitize_folder_path(from);
    let to_clean = model::sanitize_folder_path(to);
    if from_clean.is_empty() || to_clean.is_empty() {
        return Err("invalid folder path".into());
    }
    let from_abs = join_folder(base, &from_clean);
    let to_abs = join_folder(base, &to_clean);
    if !from_abs.exists() {
        return Err("source folder does not exist".into());
    }
    if to_abs.exists() {
        return Err("target folder already exists".into());
    }
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(io_err_to_string)?;
    }
    std::fs::rename(&from_abs, &to_abs).map_err(io_err_to_string)?;
    Ok(())
}

#[tauri::command]
pub async fn notes_rename_folder(app: AppHandle, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_rename_folder_impl(&base, &from, &to)
    })
    .await
    .map_err(task_join_err)?
}

/// Delete a folder + contents: routed through the system trash on desktop,
/// hard-delete on mobile.
fn notes_delete_folder_impl(base: &Path, path: &str) -> Result<(), String> {
    let clean = model::sanitize_folder_path(path);
    if clean.is_empty() {
        return Err("invalid folder path".into());
    }
    let target = join_folder(base, &clean);
    if !target.exists() {
        return Ok(());
    }
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        if let Err(err) = trash::delete(&target) {
            eprintln!("[folder-delete] trash::delete failed: {err}; falling back to hard delete");
            std::fs::remove_dir_all(&target).map_err(io_err_to_string)?;
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        std::fs::remove_dir_all(&target).map_err(io_err_to_string)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn notes_delete_folder(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        notes_delete_folder_impl(&base, &path)
    })
    .await
    .map_err(task_join_err)?
}

/// Join a model-sanitized folder path (each component already filename-safe,
/// no `.`/`..`/empty segments) onto `base`.
fn join_folder(base: &Path, clean: &str) -> std::path::PathBuf {
    let mut abs = base.to_path_buf();
    for component in clean.split('/') {
        abs.push(component);
    }
    abs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_notes_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "futo-notes-cmd-test-{}-{n}",
            futo_notes_core::files::now_ms()
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn cleanup_temp_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    fn empty_suppressed() -> Arc<Mutex<HashMap<String, i64>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    #[test]
    fn create_write_read_scan_roundtrip() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();

        let id = notes_create_impl(&base, &suppressed, "Hello", "").expect("create");
        assert_eq!(id, "Hello");

        let mtime = notes_write_impl(&base, &suppressed, &id, "#tag\nbody text", None).expect("write");
        assert!(mtime > 0);

        assert_eq!(model::read_note(&base, &id), "#tag\nbody text");
        assert!(model::note_exists(&base, &id));

        let scanned = model::scan_notes(&base);
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].id, "Hello");
        assert_eq!(scanned[0].title, "Hello");
        assert_eq!(scanned[0].tags, vec!["tag"]);
        assert_eq!(scanned[0].preview, "#tag body text");

        // The write suppressed its own filename echo.
        assert!(suppressed.lock().unwrap().contains_key("Hello.md"));

        cleanup_temp_dir(&base);
    }

    #[test]
    fn write_honors_mtime_override() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_create_impl(&base, &suppressed, "n", "").unwrap();
        let mtime = notes_write_impl(&base, &suppressed, "n", "x", Some(1_700_000_000_000)).unwrap();
        assert_eq!(mtime, 1_700_000_000_000);
        cleanup_temp_dir(&base);
    }

    #[test]
    fn rename_suppresses_old_and_new() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "a", "content", None).unwrap();
        let final_id = notes_rename_impl(&base, &suppressed, "a", "b").unwrap();
        assert_eq!(final_id, "b");
        assert!(!model::note_exists(&base, "a"));
        assert!(model::note_exists(&base, "b"));
        let map = suppressed.lock().unwrap();
        assert!(map.contains_key("a.md"));
        assert!(map.contains_key("b.md"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn rename_collision_resolves_and_suppresses_final() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "a", "a-body", None).unwrap();
        notes_write_impl(&base, &suppressed, "b", "b-body", None).unwrap();
        let final_id = notes_rename_impl(&base, &suppressed, "a", "b").unwrap();
        assert_eq!(final_id, "b-2");
        assert!(suppressed.lock().unwrap().contains_key("b-2.md"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn move_into_folder() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "note", "x", None).unwrap();
        let final_id = notes_move_impl(&base, &suppressed, "note", "Specs").unwrap();
        assert_eq!(final_id, "Specs/note");
        assert!(model::note_exists(&base, "Specs/note"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn delete_is_idempotent_on_missing() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_delete_impl(&base, &suppressed, "ghost").expect("delete missing ok");
        cleanup_temp_dir(&base);
    }

    #[test]
    fn delete_to_trash_prunes_empty_parents() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "Specs/only", "x", None).unwrap();
        notes_delete_to_trash_impl(&base, &suppressed, "Specs/only").unwrap();
        assert!(!model::note_exists(&base, "Specs/only"));
        // The now-empty Specs folder is pruned.
        assert!(!base.join("Specs").exists());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn rename_folder_moves_subtree() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "Old/a", "x", None).unwrap();
        notes_rename_folder_impl(&base, "Old", "New").unwrap();
        assert!(model::note_exists(&base, "New/a"));
        assert!(!model::note_exists(&base, "Old/a"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn rename_folder_rejects_existing_target() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "Old/a", "x", None).unwrap();
        model::create_folder(&base, "New").unwrap();
        let err = notes_rename_folder_impl(&base, "Old", "New").unwrap_err();
        assert!(err.contains("already exists"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn create_folder_returns_sanitized_path() {
        let base = temp_notes_dir();
        let p = model::create_folder(&base, "Specs//Drafts ").unwrap();
        assert_eq!(p, "Specs/Drafts");
        assert!(base.join("Specs").join("Drafts").exists());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_folders_lists_ancestors_and_empty_dirs() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "A/B/note", "x", None).unwrap();
        model::create_folder(&base, "Empty").unwrap();
        let folders = model::scan_folders(&base);
        assert_eq!(folders, vec!["A", "A/B", "Empty"]);
        cleanup_temp_dir(&base);
    }
}
