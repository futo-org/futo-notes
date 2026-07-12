//! Legacy `fs_*` command compatibility surface.
//!
//! The frontend has migrated to `notes_*`, but released clients and automation
//! may still invoke these names. They delegate to the canonical model/desktop
//! services and contain no independent note-domain rules.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::background_tasks::blocking;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFileMeta {
    pub name: String,
    pub mtime_ms: i64,
    pub size_bytes: u64,
}

fn list_note_files(root: &Path) -> Vec<NoteFileMeta> {
    let mut notes = Vec::new();
    collect_note_files(root, root, 0, &mut notes);
    notes.sort_by(|left, right| right.mtime_ms.cmp(&left.mtime_ms));
    notes
}

/// Preserve the legacy metadata-only walk: callers use this on the save path
/// to read authoritative mtimes without paying to read and parse note bodies.
fn collect_note_files(root: &Path, directory: &Path, depth: usize, notes: &mut Vec<NoteFileMeta>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if depth <= futo_notes_core::files::MAX_FOLDER_DEPTH {
                collect_note_files(root, &path, depth + 1, notes);
            }
            continue;
        }
        if !file_type.is_file() || !name.to_string_lossy().ends_with(".md") {
            continue;
        }
        let Some(relative_path) = path
            .strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .map(|path| path.replace('\\', "/"))
        else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        notes.push(NoteFileMeta {
            name: relative_path,
            mtime_ms: futo_notes_core::files::file_mtime_ms(&metadata),
            size_bytes: metadata.len(),
        });
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
}

fn list_folders(root: &Path) -> Vec<FolderEntry> {
    let mut folders = Vec::new();
    collect_folders(root, root, 0, &mut folders);
    folders.sort_by(|left, right| left.path.cmp(&right.path));
    folders
}

fn collect_folders(root: &Path, directory: &Path, depth: usize, folders: &mut Vec<FolderEntry>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if !entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let path = entry.path();
        let entry_depth = depth + 1;
        if entry_depth > futo_notes_core::files::MAX_FOLDER_DEPTH + 1 {
            continue;
        }
        if let Some(relative_path) = path
            .strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .map(|path| path.replace('\\', "/"))
        {
            folders.push(FolderEntry {
                path: relative_path,
            });
        }
        collect_folders(root, &path, entry_depth, folders);
    }
}

#[tauri::command]
pub async fn fs_list_notes_with_meta(app: AppHandle) -> Result<Vec<NoteFileMeta>, String> {
    blocking(move || Ok(list_note_files(&crate::vault_location::root(&app)?))).await
}

#[tauri::command]
pub async fn fs_list_folders(app: AppHandle) -> Result<Vec<FolderEntry>, String> {
    blocking(move || Ok(list_folders(&crate::vault_location::root(&app)?))).await
}

#[cfg(test)]
mod tests {
    //! Tests for legacy filesystem command compatibility.
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "futo-tauri-compat-{}-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn legacy_metadata_shape_keeps_filename_and_size() {
        let root = temp_dir();
        futo_notes_model::write_note(&root, "Folder/note", "hello").unwrap();
        let notes = list_note_files(&root);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].name, "Folder/note.md");
        assert_eq!(notes[0].size_bytes, 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_metadata_returns_empty_for_a_missing_root() {
        let root = std::env::temp_dir().join(format!(
            "futo-tauri-compat-missing-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        assert!(list_note_files(&root).is_empty());
    }

    #[test]
    fn legacy_metadata_excludes_non_notes_and_hidden_directories() {
        let root = temp_dir();
        fs::write(root.join("image.png"), "image").unwrap();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join(".obsidian/hidden.md"), "hidden").unwrap();
        futo_notes_model::write_note(&root, "visible", "body").unwrap();
        let notes = list_note_files(&root);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].name, "visible.md");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_metadata_recurses_and_sorts_by_mtime_descending() {
        let root = temp_dir();
        fs::create_dir_all(root.join("A/B")).unwrap();
        fs::write(root.join("older.md"), "old").unwrap();
        fs::write(root.join("A/B/newer.md"), "new").unwrap();
        futo_notes_core::files::set_file_mtime_ms(&root.join("older.md"), 1_000_000_000_000)
            .unwrap();
        futo_notes_core::files::set_file_mtime_ms(&root.join("A/B/newer.md"), 2_000_000_000_000)
            .unwrap();

        let notes = list_note_files(&root);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].name, "A/B/newer.md");
        assert_eq!(notes[1].name, "older.md");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_folder_listing_is_sorted_and_skips_hidden_directories() {
        let root = temp_dir();
        fs::create_dir_all(root.join("B/Nested")).unwrap();
        fs::create_dir_all(root.join("A")).unwrap();
        fs::create_dir_all(root.join(".hidden/Skipped")).unwrap();

        let folders = list_folders(&root)
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();
        assert_eq!(folders, vec!["A", "B", "B/Nested"]);
        fs::remove_dir_all(root).unwrap();
    }
}
