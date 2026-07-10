//! Desktop vault location resolution and persisted override policy.
//!
//! This is the only desktop module allowed to decide where the vault lives.
//! The debug/production split is a data-safety boundary, not a convenience.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::background_tasks::{blocking, io_error};

const OVERRIDE_FILE: &str = "notes-dir-override.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VaultOverride {
    notes_dir: Option<String>,
}

pub(crate) fn environment_data_dir() -> Option<PathBuf> {
    std::env::var("FUTO_NOTES_DATA_DIR").ok().map(PathBuf::from)
}

fn override_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = environment_data_dir() {
        return Ok(data_dir.join(OVERRIDE_FILE));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(OVERRIDE_FILE))
}

fn load_override(app: &AppHandle) -> Option<PathBuf> {
    let raw = fs::read_to_string(override_path(app).ok()?).ok()?;
    serde_json::from_str::<VaultOverride>(&raw)
        .ok()?
        .notes_dir
        .map(PathBuf::from)
}

fn save_override(app: &AppHandle, directory: Option<&str>) -> Result<(), String> {
    let path = override_path(app)?;
    let value = VaultOverride {
        notes_dir: directory.map(str::to_owned),
    };
    let json = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    futo_notes_core::files::write_atomic_text(&path, &json)
}

pub(crate) fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = environment_data_dir() {
        return Ok(data_dir.join("notes"));
    }

    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| error.to_string())?;

    #[cfg(debug_assertions)]
    return Ok(documents.join("fake-notes"));

    #[cfg(not(debug_assertions))]
    Ok(documents.join("futo-notes"))
}

pub(crate) fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = load_override(app).map_or_else(|| default_root(app), Ok)?;
    fs::create_dir_all(&root).map_err(io_error)?;
    Ok(root)
}

pub(crate) fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn notes_dir_override_load(app: AppHandle) -> Result<Option<String>, String> {
    blocking(move || Ok(load_override(&app).map(|path| path.to_string_lossy().into_owned()))).await
}

#[tauri::command]
pub async fn notes_dir_override_save(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    blocking(move || save_override(&app, dir.as_deref())).await
}

#[tauri::command]
pub async fn resolve_default_notes_root(app: AppHandle) -> Result<String, String> {
    blocking(move || Ok(default_root(&app)?.to_string_lossy().into_owned())).await
}

#[cfg(test)]
mod tests {
    //! Tests for vault location resolution.
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn environment_data_dir_tracks_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("FUTO_NOTES_DATA_DIR");
        std::env::remove_var("FUTO_NOTES_DATA_DIR");
        assert_eq!(environment_data_dir(), None);

        std::env::set_var("FUTO_NOTES_DATA_DIR", "/tmp/futo-vault-test");
        assert_eq!(
            environment_data_dir(),
            Some(PathBuf::from("/tmp/futo-vault-test"))
        );

        match previous {
            Some(value) => std::env::set_var("FUTO_NOTES_DATA_DIR", value),
            None => std::env::remove_var("FUTO_NOTES_DATA_DIR"),
        }
    }
}
