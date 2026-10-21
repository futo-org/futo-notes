use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::checkpoint::{self, ConnectedState};
use crate::journal::SyncRunJournal;
use crate::server::HttpClients;
use crate::sync::{self, PreWrite, Progress, SaveCheckpoint, SyncErrorKind, SyncSummary};

pub(super) async fn run(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    gate: &Arc<Mutex<()>>,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    run_journal: &SyncRunJournal,
    clients: &HttpClients,
) -> Result<SyncSummary, SyncErrorKind> {
    run_with_checkpoint_and_clients(
        state,
        gate,
        root,
        progress,
        pre_write,
        &checkpoint::save,
        run_journal,
        clients,
    )
    .await
}

#[cfg(test)]
async fn run_with_checkpoint(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    gate: &Arc<Mutex<()>>,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
    run_journal: &SyncRunJournal,
) -> Result<SyncSummary, SyncErrorKind> {
    let clients = HttpClients::new().map_err(super::connect::http_error)?;
    run_with_checkpoint_and_clients(
        state,
        gate,
        root,
        progress,
        pre_write,
        save_checkpoint,
        run_journal,
        &clients,
    )
    .await
}

async fn run_with_checkpoint_and_clients(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    gate: &Arc<Mutex<()>>,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
    run_journal: &SyncRunJournal,
    clients: &HttpClients,
) -> Result<SyncSummary, SyncErrorKind> {
    let _gate = gate.lock().await;
    let current = state
        .lock()
        .await
        .clone()
        .ok_or(SyncErrorKind::NotConnected)?;
    match sync::cycle_with_checkpoint_and_clients(
        &current,
        root,
        progress,
        pre_write,
        save_checkpoint,
        run_journal,
        clients,
    )
    .await
    {
        Ok((summary, next)) => {
            *state.lock().await = Some(next);
            Ok(summary)
        }
        Err(failure) => {
            *state.lock().await = Some(failure.state);
            Err(failure.kind)
        }
    }
}

#[cfg(test)]
mod tests;
