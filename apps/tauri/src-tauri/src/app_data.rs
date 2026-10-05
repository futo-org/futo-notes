//! The files the frontend keeps in the vault beside the notes:
//! `.app-state.json`, `.app-config.json` and `.crashlogs/`.

use tauri::AppHandle;

use crate::background_tasks::blocking;

/// Written by the vault engine, as a note is: atomically, beneath the one
/// active root (so a vanished custom root is never recreated), and a write the
/// OS refuses marks the vault unusable (`vault_fs::access_refused`) exactly as a
/// refused note save does — the settings file is often the first write a vault
/// refuses (crash #1788).
#[tauri::command]
pub async fn app_data_write(app: AppHandle, path: String, content: String) -> Result<(), String> {
    blocking(move || {
        let root = crate::vault_location::root(&app)?;
        futo_notes_core::files::vault_fs::write_atomic_local(&root, &path, content.as_bytes())
    })
    .await
}
