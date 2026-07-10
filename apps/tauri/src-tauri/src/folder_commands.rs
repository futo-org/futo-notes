//! Tauri commands for desktop folder operations.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::application_state::AppState;
use crate::background_tasks::{blocking, io_error};
use crate::filesystem_watcher::WatcherSuppression;

fn create_folder_impl(root: &Path, path: &str) -> Result<String, String> {
    futo_notes_model::create_folder(root, path)
}

#[tauri::command]
pub async fn notes_create_folder(app: AppHandle, path: String) -> Result<String, String> {
    blocking(move || {
        let root = crate::vault_location::root(&app)?;
        create_folder_impl(&root, &path)
    })
    .await
}

fn rename_folder_impl(
    root: &Path,
    suppression: &WatcherSuppression,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let from = futo_notes_model::sanitize_folder_path(from);
    let to = futo_notes_model::sanitize_folder_path(to);
    if from.is_empty() || to.is_empty() {
        return Err("invalid folder path".to_owned());
    }

    let source = join(root, &from);
    let destination = join(root, &to);
    if !source.exists() {
        return Err("source folder does not exist".to_owned());
    }
    if destination.exists() {
        return Err("target folder already exists".to_owned());
    }

    for relative_path in watcher_paths_under(root, &from) {
        let suffix = relative_path.strip_prefix(&from).unwrap_or_default();
        suppression.register(&relative_path);
        suppression.register(&format!("{to}{suffix}"));
    }
    crate::vault_location::ensure_parent(&destination)?;
    std::fs::rename(source, destination).map_err(io_error)
}

#[tauri::command]
pub async fn notes_rename_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let suppression = state.watcher.suppression();
    blocking(move || {
        rename_folder_impl(
            &crate::vault_location::root(&app)?,
            &suppression,
            &from,
            &to,
        )
    })
    .await
}

pub(crate) fn delete_folder_impl(
    root: &Path,
    suppression: &WatcherSuppression,
    path: &str,
) -> Result<(), String> {
    let path = futo_notes_model::sanitize_folder_path(path);
    if path.is_empty() {
        return Err("invalid folder path".to_owned());
    }
    delete_folder_at_path(root, suppression, &path)
}

pub(crate) fn delete_folder_at_path(
    root: &Path,
    suppression: &WatcherSuppression,
    path: &str,
) -> Result<(), String> {
    let target = join(root, path);
    if !target.exists() {
        return Ok(());
    }
    for relative_path in watcher_paths_under(root, path) {
        suppression.register(&relative_path);
    }
    crate::system_trash::delete(&target, "folder-delete")
}

#[tauri::command]
pub async fn notes_delete_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let suppression = state.watcher.suppression();
    blocking(move || delete_folder_impl(&crate::vault_location::root(&app)?, &suppression, &path))
        .await
}

fn join(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_owned(), |path, component| path.join(component))
}

fn watcher_paths_under(root: &Path, folder: &str) -> Vec<String> {
    let mut paths = Vec::new();
    collect_watcher_paths(root, &join(root, folder), &mut paths);
    paths
}

fn collect_watcher_paths(root: &Path, directory: &Path, paths: &mut Vec<String>) {
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
            collect_watcher_paths(root, &path, paths);
            continue;
        }
        let name = name.to_string_lossy();
        if !file_type.is_file() || (!name.ends_with(".md") && !name.ends_with(".txt")) {
            continue;
        }
        if let Some(relative_path) = path
            .strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .map(|path| path.replace('\\', "/"))
        {
            paths.push(relative_path);
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests for folder command implementations.
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn root() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "futo-tauri-folders-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rename_moves_subtree_and_suppresses_every_note_path() {
        let root = root();
        futo_notes_model::write_note(&root, "Old/a", "a").unwrap();
        futo_notes_model::write_note(&root, "Old/Nested/b", "b").unwrap();
        std::fs::write(root.join("Old/legacy.txt"), "legacy").unwrap();
        let suppression = WatcherSuppression::default();
        rename_folder_impl(&root, &suppression, "Old", "New").unwrap();

        assert!(futo_notes_model::note_exists(&root, "New/a"));
        assert!(futo_notes_model::note_exists(&root, "New/Nested/b"));
        for path in [
            "Old/a.md",
            "Old/Nested/b.md",
            "Old/legacy.txt",
            "New/a.md",
            "New/Nested/b.md",
            "New/legacy.txt",
        ] {
            assert!(suppression.contains(path), "missing suppression for {path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_rejects_an_existing_target_without_mutating_source() {
        let root = root();
        futo_notes_model::write_note(&root, "Old/a", "a").unwrap();
        futo_notes_model::create_folder(&root, "New").unwrap();
        let error =
            rename_folder_impl(&root, &WatcherSuppression::default(), "Old", "New").unwrap_err();
        assert!(error.contains("already exists"));
        assert!(futo_notes_model::note_exists(&root, "Old/a"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_folder_keeps_the_canonical_sanitization_contract() {
        let root = root();
        let created = create_folder_impl(&root, "Specs//Drafts ").unwrap();
        assert_eq!(created, "Specs/Drafts");
        assert!(root.join("Specs/Drafts").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_suppresses_every_note_in_the_subtree() {
        let root = root();
        futo_notes_model::write_note(&root, "Old/a", "a").unwrap();
        futo_notes_model::write_note(&root, "Old/Nested/b", "b").unwrap();
        std::fs::write(root.join("Old/legacy.txt"), "legacy").unwrap();
        let suppression = WatcherSuppression::default();
        delete_folder_impl(&root, &suppression, "Old").unwrap();

        assert!(!root.join("Old").exists());
        assert!(suppression.contains("Old/a.md"));
        assert!(suppression.contains("Old/Nested/b.md"));
        assert!(suppression.contains("Old/legacy.txt"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
