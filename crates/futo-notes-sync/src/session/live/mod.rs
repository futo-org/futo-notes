mod connected_stream;
mod event_stream;
mod runner;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};

use crate::checkpoint::ConnectedState;
use crate::sync::PreWrite;

use super::SyncSessionListener;

pub(super) struct LiveTask {
    cancel: mpsc::Sender<()>,
    note_changed: mpsc::Sender<()>,
    abort: tokio::task::AbortHandle,
}

impl LiveTask {
    pub(super) fn notify_note_changed(&self) {
        let _ = self.note_changed.try_send(());
    }

    pub(super) fn stop(self) {
        let _ = self.cancel.try_send(());
        self.abort.abort();
    }
}

pub(super) fn spawn_live_task(
    state: Arc<Mutex<Option<ConnectedState>>>,
    cycle_gate: Arc<Mutex<()>>,
    root: PathBuf,
    listener: Arc<dyn SyncSessionListener>,
    pre_write: Arc<PreWrite>,
) -> LiveTask {
    let (cancel_sender, cancel_receiver) = mpsc::channel(1);
    let (note_changed_sender, note_changed_receiver) = mpsc::channel(1);
    let task = tokio::spawn(runner::run_live_task(
        state,
        cycle_gate,
        root,
        listener,
        pre_write,
        cancel_receiver,
        note_changed_receiver,
    ));

    LiveTask {
        cancel: cancel_sender,
        note_changed: note_changed_sender,
        abort: task.abort_handle(),
    }
}
