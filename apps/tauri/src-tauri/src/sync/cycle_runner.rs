//! Manual and live sync entry points for the desktop shell.

use std::sync::Arc;

use futo_notes_sync::{SyncProgress, SyncSessionListener};
use tauri::{AppHandle, Emitter};

use super::frontend_contract::SyncSummary;
use super::tauri_events::TauriSyncListener;
use crate::application_state::AppState;

pub(super) async fn run_manual(app: &AppHandle, state: &AppState) -> Result<SyncSummary, String> {
    let root = crate::vault_location::root(app)?;
    let progress_app = app.clone();
    let progress = move |progress: SyncProgress| {
        let _ = progress_app.emit(
            "sync:progress",
            serde_json::json!({
                "phase": progress.phase,
                "current": progress.current,
                "total": progress.total,
            }),
        );
    };
    let suppression = state.watcher.suppression();
    let pre_write = move |filename: &str| suppression.register(filename);
    let summary = state.sync.sync(&root, &progress, &pre_write).await?;
    Ok(SyncSummary::from(&summary))
}

pub(super) async fn start_live(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let root = crate::vault_location::root(app)?;
    let suppression = state.watcher.suppression();
    let pre_write: Arc<futo_notes_sync::PreWrite> =
        Arc::new(move |filename: &str| suppression.register(filename));
    let listener: Arc<dyn SyncSessionListener> = Arc::new(TauriSyncListener { app: app.clone() });
    state.sync.start_live(root, listener, pre_write).await?;
    Ok(())
}
