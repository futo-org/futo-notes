//! Thin desktop projection of the shared local-note store.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futo_notes_store::{
    BeforeWrite, BootstrapResult, FileChange, LocalNoteStore, MutationResult, SearchHit,
    SearchStatus, Snapshot, VaultFile,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::application_state::AppState;
use crate::background_tasks::blocking;
use crate::filesystem_watcher::WatcherSuppression;

struct DesktopBeforeWrite(WatcherSuppression);

impl BeforeWrite for DesktopBeforeWrite {
    fn before_write(&self, changes: &[FileChange]) {
        for change in changes {
            match change {
                FileChange::Changed(path) | FileChange::Removed(path) => self.0.register(path),
                FileChange::Renamed { from, to } => {
                    self.0.register(from);
                    self.0.register(to);
                }
            }
        }
    }
}

struct ActiveStore {
    root: PathBuf,
    store: Arc<LocalNoteStore>,
}

#[derive(Default)]
pub(crate) struct NoteStoreState {
    active: Mutex<Option<ActiveStore>>,
}

impl NoteStoreState {
    fn get(
        &self,
        app: &AppHandle,
        suppression: WatcherSuppression,
    ) -> Result<Arc<LocalNoteStore>, String> {
        let root = crate::vault_location::root(app)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "local-note store lock poisoned".to_owned())?;
        if let Some(active) = active.as_ref() {
            if active.root == root {
                return Ok(active.store.clone());
            }
        }
        let store = Arc::new(LocalNoteStore::with_before_write(
            root.clone(),
            Arc::new(DesktopBeforeWrite(suppression)),
        ));
        *active = Some(ActiveStore {
            root,
            store: store.clone(),
        });
        Ok(store)
    }

    pub(crate) fn observe(&self, change: FileChange) {
        if let Ok(active) = self.active.lock() {
            if let Some(active) = active.as_ref() {
                active.store.observe_external_change(change);
            }
        }
    }
}

fn store(app: &AppHandle, state: &AppState) -> Result<Arc<LocalNoteStore>, String> {
    state.notes.get(app, state.watcher.suppression())
}

fn search_index_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = crate::vault_location::environment_data_dir().map_or_else(
        || app.path().app_data_dir().map_err(|error| error.to_string()),
        Ok,
    )?;
    let directory = base.join("search");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn start_search(app: &AppHandle, store: &LocalNoteStore) -> Result<(), String> {
    let emit_app = app.clone();
    store.start_search(
        search_index_dir(app)?,
        Arc::new(move |status| {
            let _ = emit_app.emit("search:status", status);
        }),
    )
}

pub(crate) fn init_on_startup(app: &AppHandle) {
    let app = app.clone();
    let _ = crate::background_tasks::spawn("futo-local-notes-init", move || {
        let state: State<'_, AppState> = app.state();
        match store(&app, &state).and_then(|store| start_search(&app, &store)) {
            Ok(()) => {}
            Err(error) => eprintln!("[local-notes] search startup failed: {error}"),
        }
    });
}

#[tauri::command]
pub async fn local_notes_bootstrap(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapResult, String> {
    let store = store(&app, &state)?;
    // `store()` may have switched roots after a vault-location change. Search
    // startup is idempotent for an existing store and required for a new one.
    start_search(&app, &store)?;
    blocking(move || store.bootstrap()).await
}

#[tauri::command]
pub async fn local_notes_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let store = store(&app, &state)?;
    blocking(move || Ok(store.snapshot())).await
}

#[tauri::command]
pub async fn local_notes_inventory(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<VaultFile>, String> {
    let store = store(&app, &state)?;
    blocking(move || Ok(store.inventory())).await
}

#[tauri::command]
pub async fn local_notes_read(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let store = store(&app, &state)?;
    blocking(move || Ok(store.read(&id))).await
}

#[tauri::command]
pub async fn local_notes_exists(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let store = store(&app, &state)?;
    blocking(move || Ok(store.exists(&id))).await
}

#[tauri::command]
pub async fn local_notes_save(
    app: AppHandle,
    state: State<'_, AppState>,
    original_id: Option<String>,
    wanted_id: String,
    content: String,
    modified_ms: Option<i64>,
) -> Result<MutationResult, String> {
    let store = store(&app, &state)?;
    blocking(move || store.save(original_id.as_deref(), &wanted_id, &content, modified_ms)).await
}

#[tauri::command]
pub async fn local_notes_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<MutationResult, String> {
    let store = store(&app, &state)?;
    blocking(move || {
        store.delete_with(&id, |path| crate::system_trash::delete(path, "note-delete"))
    })
    .await
}

#[tauri::command]
pub async fn local_notes_move(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    wanted_id: String,
) -> Result<MutationResult, String> {
    let store = store(&app, &state)?;
    blocking(move || store.rename(&id, &wanted_id)).await
}

#[tauri::command]
pub async fn local_notes_create_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let store = store(&app, &state)?;
    blocking(move || store.create_folder(&path)).await
}

#[tauri::command]
pub async fn local_notes_rename_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<MutationResult, String> {
    let store = store(&app, &state)?;
    blocking(move || store.rename_folder(&from, &to)).await
}

#[tauri::command]
pub async fn local_notes_delete_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<MutationResult, String> {
    let store = store(&app, &state)?;
    blocking(move || {
        store.delete_folder_with(&path, |folder| {
            crate::system_trash::delete(folder, "folder-delete")
        })
    })
    .await
}

#[tauri::command]
pub async fn local_notes_reset(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let store = store(&app, &state)?;
    blocking(move || store.reset()).await
}

#[tauri::command]
pub async fn local_notes_search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let store = store(&app, &state)?;
    blocking(move || store.search(&query, limit)).await
}

#[tauri::command]
pub async fn local_notes_search_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SearchStatus, String> {
    Ok(store(&app, &state)?.search_status())
}

#[tauri::command]
pub async fn local_notes_rescan(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    store(&app, &state)?.rebuild_search();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_projection_registers_both_sides_of_a_rename() {
        let suppression = WatcherSuppression::default();
        DesktopBeforeWrite(suppression.clone()).before_write(&[FileChange::Renamed {
            from: "old.md".into(),
            to: "new.md".into(),
        }]);
        assert!(suppression.contains("old.md"));
        assert!(suppression.contains("new.md"));
    }
}
