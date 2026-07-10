//! Manual and live push-first sync cycle runner.

use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_sync::live::{LiveFuture, LiveHandle, SyncSessionListener};
use futo_notes_sync::{ConnectedState, SyncProgress};
use tauri::{AppHandle, Emitter};

use super::frontend_contract::SyncSummary;
use super::session_state::TauriTask;
use super::tauri_events::TauriSyncListener;
use crate::application_state::AppState;
use crate::filesystem_watcher::WatcherSuppression;

pub(super) async fn run_manual(app: &AppHandle, state: &AppState) -> Result<SyncSummary, String> {
    // The gate covers the complete cycle so a concurrent live cycle cannot
    // race or regress the sync cursor.
    let _gate = state.sync.lock_sync_gate().await;
    let snapshot = state.sync.snapshot().await.ok_or("E2EE not connected")?;
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

    let (summary, next) =
        futo_notes_sync::run_sync(&snapshot, &root, &progress, &pre_write).await?;
    state.sync.set_connected(next).await;
    Ok(SyncSummary::from(&summary))
}

pub(super) async fn start_live(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if !state.sync.is_connected().await {
        return Err("E2EE not connected".to_owned());
    }

    let root = crate::vault_location::root(app)?;
    let inner = state.sync.inner_arc();
    let sync_gate = state.sync.sync_gate_arc();
    let suppression = state.watcher.suppression();
    let listener: Arc<dyn SyncSessionListener> = Arc::new(TauriSyncListener { app: app.clone() });

    state.sync.start_live_with(
        listener,
        |listener| LiveHandle {
            snapshot: snapshot_reader(Arc::clone(&inner)),
            cycle: live_cycle(
                Arc::clone(&inner),
                Arc::clone(&sync_gate),
                suppression,
                app.clone(),
                root,
            ),
            listener,
        },
        |handle, cancel_rx, note_rx| {
            TauriTask(tauri::async_runtime::spawn(async move {
                futo_notes_sync::live::watch(handle, cancel_rx, note_rx).await;
            }))
        },
    );
    Ok(())
}

fn snapshot_reader(
    inner: Arc<tokio::sync::Mutex<Option<ConnectedState>>>,
) -> Box<dyn Fn() -> LiveFuture<Option<ConnectedState>> + Send + Sync> {
    Box::new(move || {
        let inner = Arc::clone(&inner);
        Box::pin(async move { inner.lock().await.clone() })
    })
}

fn live_cycle(
    inner: Arc<tokio::sync::Mutex<Option<ConnectedState>>>,
    sync_gate: Arc<tokio::sync::Mutex<()>>,
    suppression: WatcherSuppression,
    app: AppHandle,
    root: PathBuf,
) -> Box<dyn Fn() -> LiveFuture<Result<Option<futo_notes_sync::SyncSummary>, String>> + Send + Sync>
{
    Box::new(move || {
        let inner = Arc::clone(&inner);
        let sync_gate = Arc::clone(&sync_gate);
        let suppression = suppression.clone();
        let app = app.clone();
        let root = root.clone();
        Box::pin(async move {
            let _gate = sync_gate.lock().await;
            let Some(snapshot) = inner.lock().await.clone() else {
                return Ok(None);
            };
            let progress = |_progress: SyncProgress| {};
            let pre_write = move |filename: &str| suppression.register(filename);
            let (summary, next) =
                futo_notes_sync::run_sync(&snapshot, &root, &progress, &pre_write)
                    .await
                    .map_err(|error| error.to_string())?;
            *inner.lock().await = Some(next);
            let _ = app.emit("sync:live-synced", SyncSummary::from(&summary));
            Ok(Some(summary))
        })
    })
}
