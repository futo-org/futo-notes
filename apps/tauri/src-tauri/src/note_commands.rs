//! Tauri commands over the canonical note CRUD and scanning in
//! `futo-notes-model::crud` — the same domain logic native iOS/Android reach
//! through the `futo-notes-ffi` `NoteStore`. This is the Tauri adapter: it
//! consumes the crate directly, it never touches the UniFFI objects.
//!
//! The command set mirrors the FFI `NoteStore` method set 1:1, plus
//! desktop-only note-trash routing. Folder commands live in `folder_commands.rs`. Every
//! command wraps a testable `_impl` fn over the resolved vault root, runs the
//! filesystem work in `spawn_blocking`, and returns `Result<_, String>`.
//!
//! Path safety is pushed DOWN: `model::crud` → `futo_notes_core::files`
//! (`safe_note_path` / `get_unique_note_id`), the same guards the FFI uses, so
//! traversal checks are not duplicated per command.
//!
//! Self-write suppression (the critical no-double-refresh discipline): every
//! mutation registers the touched relative filename(s) in the shared watcher
//! suppression service BEFORE the disk write so the watcher
//! echo for our own write is swallowed by the watcher service. The
//! optimistic cache update in `notes.svelte.ts` is then the only refresh for a
//! local edit. This mirrors what the sync orchestrator's `apply_delta`
//! (`futo-notes-sync`) already does.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use futo_notes_core::files::safe_note_path;
use futo_notes_model as model;

use crate::application_state::AppState;
use crate::background_tasks::{blocking, io_error};
use crate::filesystem_watcher::WatcherSuppression;

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
fn notes_scan_impl(base: &Path) -> Vec<NoteMeta> {
    model::scan_notes(base)
        .into_iter()
        .map(Into::into)
        .collect()
}

#[tauri::command]
pub async fn notes_scan(app: AppHandle) -> Result<Vec<NoteMeta>, String> {
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        Ok(notes_scan_impl(&base))
    })
    .await
}

/// All folder paths (note ancestors + empty dirs), sorted.
fn notes_scan_folders_impl(base: &Path) -> Vec<String> {
    model::scan_folders(base)
}

#[tauri::command]
pub async fn notes_scan_folders(app: AppHandle) -> Result<Vec<String>, String> {
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        Ok(notes_scan_folders_impl(&base))
    })
    .await
}

/// Seed the welcome note iff the vault is empty. Returns the number of notes
/// written (0 when the vault already had content). The seed content lives in
/// `futo-notes-model` (`seed_if_empty`) so desktop, iOS, and Android get an
/// identical first run. Idempotent — safe to fire un-awaited on every launch.
fn notes_seed_if_empty_impl(base: &Path, suppression: &WatcherSuppression) -> Result<u32, String> {
    if model::scan_notes(base).is_empty() {
        suppression.register(&format!("{}.md", model::WELCOME_NOTE_ID));
    }
    model::seed_if_empty(base)
}

#[tauri::command]
pub async fn notes_seed_if_empty(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        notes_seed_if_empty_impl(&base, &suppression)
    })
    .await
}

/// Read a note's content (`""` if missing).
fn notes_read_impl(base: &Path, id: &str) -> String {
    model::read_note(base, id)
}

#[tauri::command]
pub async fn notes_read(app: AppHandle, id: String) -> Result<String, String> {
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        Ok(notes_read_impl(&base, &id))
    })
    .await
}

/// Whether a note exists on disk.
fn notes_exists_impl(base: &Path, id: &str) -> bool {
    model::note_exists(base, id)
}

#[tauri::command]
pub async fn notes_exists(app: AppHandle, id: String) -> Result<bool, String> {
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        Ok(notes_exists_impl(&base, &id))
    })
    .await
}

// ── mutations ───────────────────────────────────────────────────────────

/// Atomic write + optional mtime override + post-write mtime readback, in one
/// IPC. Returns the resulting mtime (keeps the `fs_write_note_atomic`
/// readback contract that `platform/tauri.ts` depends on). Suppresses the
/// watcher echo for `{id}.md` before writing.
fn notes_write_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    id: &str,
    content: &str,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    suppression.register(&format!("{id}.md"));
    let path = safe_note_path(base, id)?;
    model::write_note(base, id, content)?;
    if let Some(ms) = modified_at_ms {
        if ms >= 0 {
            let _ = futo_notes_core::files::set_file_mtime_ms(&path, ms);
        }
    }
    let meta = std::fs::metadata(&path).map_err(io_error)?;
    Ok(futo_notes_core::files::file_mtime_ms(&meta))
}

#[tauri::command]
pub async fn notes_write(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        notes_write_impl(&base, &suppression, &id, &content, modified_at_ms)
    })
    .await
}

/// Create a note from a title (+ optional folder). Returns the final,
/// collision-resolved id.
fn notes_create_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    title: &str,
    folder: &str,
) -> Result<String, String> {
    let wanted = model::make_id(folder, title);
    let planned = futo_notes_core::files::get_unique_note_id(base, &wanted, None)?;
    suppression.register(&format!("{planned}.md"));
    let id = model::create_note(base, folder, title)?;
    if id != planned {
        // A concurrent external create can race the planning probe. Cover the
        // actual result as well; routine writes always take the pre-write path.
        suppression.register(&format!("{id}.md"));
    }
    Ok(id)
}

#[tauri::command]
pub async fn notes_create(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
    folder: String,
) -> Result<String, String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        notes_create_impl(&base, &suppression, &title, &folder)
    })
    .await
}

/// Hard-delete a note (missing is not an error). Does NOT prune empty parents
/// (matches the FFI / model `delete_note` contract; trash + pruning is the
/// `notes_delete_to_trash` desktop affordance).
fn notes_delete_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    id: &str,
) -> Result<(), String> {
    suppression.register(&format!("{id}.md"));
    model::delete_note(base, id)
}

#[tauri::command]
pub async fn notes_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        notes_delete_impl(&base, &suppression, &id)
    })
    .await
}

/// Rename/move a note. Returns the final (collision-resolved) id. Suppresses
/// both old + new filename echoes.
pub(crate) fn rename_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    old_id: &str,
    new_id: &str,
) -> Result<String, String> {
    let planned = planned_rename_id(base, old_id, new_id)?;
    suppression.register(&format!("{old_id}.md"));
    suppression.register(&format!("{new_id}.md"));
    suppression.register(&format!("{planned}.md"));
    let final_id = model::rename_note(base, old_id, new_id)?;
    if final_id != planned {
        // Only possible if an external writer wins a race after planning.
        suppression.register(&format!("{final_id}.md"));
    }
    Ok(final_id)
}

fn planned_rename_id(base: &Path, old_id: &str, new_id: &str) -> Result<String, String> {
    if old_id == new_id || futo_notes_core::sync::collides_but_differs(old_id, new_id) {
        return Ok(new_id.to_owned());
    }
    futo_notes_core::files::get_unique_note_id(base, new_id, None)
}

/// Exact-id move retained for the legacy `fs_move_note` IPC contract. Unlike
/// `notes_rename`, this endpoint rejects collisions instead of resolving them.
pub(crate) fn move_exact_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    from_id: &str,
    to_id: &str,
) -> Result<(), String> {
    let from = safe_note_path(base, from_id)?;
    let to = safe_note_path(base, to_id)?;
    if !from.exists() {
        return Err("source note does not exist".to_owned());
    }
    if to.exists() {
        return Err("target note already exists".to_owned());
    }
    suppression.register(&format!("{from_id}.md"));
    suppression.register(&format!("{to_id}.md"));
    crate::vault_location::ensure_parent(&to)?;
    std::fs::rename(&from, &to).map_err(io_error)?;
    model::prune_empty_parent_dirs(base, &from);
    Ok(())
}

#[tauri::command]
pub async fn notes_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    old_id: String,
    new_id: String,
) -> Result<String, String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        rename_impl(&base, &suppression, &old_id, &new_id)
    })
    .await
}

/// Move a note into `folder` (`""` = root), keeping its leaf. Returns the
/// final id. Suppresses both old + new filename echoes.
fn notes_move_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    id: &str,
    folder: &str,
) -> Result<String, String> {
    let (_, leaf) = model::split_id(id);
    let folder = model::sanitize_folder_path(folder);
    let requested = if folder.is_empty() {
        leaf
    } else {
        format!("{folder}/{leaf}")
    };
    let planned = planned_rename_id(base, id, &requested)?;
    suppression.register(&format!("{id}.md"));
    suppression.register(&format!("{planned}.md"));
    let final_id = model::move_note(base, id, &folder)?;
    if final_id != planned {
        suppression.register(&format!("{final_id}.md"));
    }
    Ok(final_id)
}

#[tauri::command]
pub async fn notes_move(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    folder: String,
) -> Result<String, String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        notes_move_impl(&base, &suppression, &id, &folder)
    })
    .await
}

// ── desktop-only affordances (NOT on the FFI surface) ──────────────────────
//
// The note domain still owns path resolution; the desktop adds recoverable
// system-trash routing at the outermost boundary.

/// Delete a note: routed through the system trash on desktop, hard-delete on
/// mobile. Prunes now-empty parent dirs. Suppresses the watcher echo.
fn notes_delete_to_trash_impl(
    base: &Path,
    suppression: &WatcherSuppression,
    id: &str,
) -> Result<(), String> {
    suppression.register(&format!("{id}.md"));
    let path = safe_note_path(base, id)?;
    if !path.exists() {
        return Ok(());
    }
    crate::system_trash::delete(&path, "note-delete")?;
    model::prune_empty_parent_dirs(base, &path);
    Ok(())
}

#[tauri::command]
pub async fn notes_delete_to_trash(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        let base = crate::vault_location::root(&app)?;
        notes_delete_to_trash_impl(&base, &suppression, &id)
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Tests for note command implementations.
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

    fn empty_suppressed() -> WatcherSuppression {
        WatcherSuppression::default()
    }

    #[test]
    fn create_write_read_scan_roundtrip() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        let id = notes_create_impl(&base, &suppressed, "Hello", "").expect("create");
        assert_eq!(id, "Hello");
        let mtime =
            notes_write_impl(&base, &suppressed, &id, "#tag\nbody text", None).expect("write");
        assert!(mtime > 0);
        assert_eq!(notes_read_impl(&base, &id), "#tag\nbody text");
        assert!(notes_exists_impl(&base, &id));
        let scanned = notes_scan_impl(&base);
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].id, "Hello");
        assert_eq!(scanned[0].title, "Hello");
        assert_eq!(scanned[0].tags, vec!["tag"]);
        assert_eq!(scanned[0].preview, "#tag body text");
        assert!(suppressed.contains("Hello.md"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn write_honors_mtime_override() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_create_impl(&base, &suppressed, "n", "").unwrap();
        let mtime =
            notes_write_impl(&base, &suppressed, "n", "x", Some(1_700_000_000_000)).unwrap();
        assert_eq!(mtime, 1_700_000_000_000);
        cleanup_temp_dir(&base);
    }

    #[test]
    fn rename_suppresses_old_and_new() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "a", "content", None).unwrap();
        let final_id = rename_impl(&base, &suppressed, "a", "b").unwrap();
        assert_eq!(final_id, "b");
        assert!(!model::note_exists(&base, "a"));
        assert!(model::note_exists(&base, "b"));
        assert!(suppressed.contains("a.md"));
        assert!(suppressed.contains("b.md"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn rename_collision_resolves_and_suppresses_final() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "a", "a-body", None).unwrap();
        notes_write_impl(&base, &suppressed, "b", "b-body", None).unwrap();
        let final_id = rename_impl(&base, &suppressed, "a", "b").unwrap();
        assert_eq!(final_id, "b-2");
        assert!(suppressed.contains("b-2.md"));
        cleanup_temp_dir(&base);
    }

    #[test]
    fn create_collision_suppresses_the_resolved_path() {
        let base = temp_notes_dir();
        let suppression = empty_suppressed();
        notes_write_impl(&base, &suppression, "note", "existing", None).unwrap();
        let id = notes_create_impl(&base, &suppression, "note", "").unwrap();
        assert_eq!(id, "note-2");
        assert!(suppression.contains("note-2.md"));
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
    fn exact_legacy_move_rejects_collision_without_mutating_either_note() {
        let base = temp_notes_dir();
        let suppression = empty_suppressed();
        notes_write_impl(&base, &suppression, "a", "a-body", None).unwrap();
        notes_write_impl(&base, &suppression, "b", "b-body", None).unwrap();
        let error = move_exact_impl(&base, &suppression, "a", "b").unwrap_err();
        assert!(error.contains("already exists"));
        assert_eq!(notes_read_impl(&base, "a"), "a-body");
        assert_eq!(notes_read_impl(&base, "b"), "b-body");
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
        assert!(!base.join("Specs").exists());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_folders_lists_ancestors_and_empty_dirs() {
        let base = temp_notes_dir();
        let suppressed = empty_suppressed();
        notes_write_impl(&base, &suppressed, "A/B/note", "x", None).unwrap();
        model::create_folder(&base, "Empty").unwrap();
        assert_eq!(notes_scan_folders_impl(&base), vec!["A", "A/B", "Empty"]);
        cleanup_temp_dir(&base);
    }

    #[test]
    fn seed_is_idempotent_and_suppresses_the_welcome_write() {
        let base = temp_notes_dir();
        let suppression = empty_suppressed();
        assert_eq!(notes_seed_if_empty_impl(&base, &suppression).unwrap(), 1);
        assert!(suppression.contains("Welcome.md"));
        assert_eq!(notes_seed_if_empty_impl(&base, &suppression).unwrap(), 0);
        cleanup_temp_dir(&base);
    }
}
