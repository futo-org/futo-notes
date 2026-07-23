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
    task: tokio::task::JoinHandle<()>,
}

impl LiveTask {
    pub(super) fn notify_note_changed(&self) {
        let _ = self.note_changed.try_send(());
    }

    pub(super) fn abort(self) {
        let _ = self.cancel.try_send(());
        self.task.abort();
    }

    pub(super) async fn stop_and_wait(self) {
        let _ = self.cancel.send(()).await;
        let _ = self.task.await;
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
        task,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    #[tokio::test]
    async fn graceful_stop_waits_for_task_cleanup_instead_of_aborting_it() {
        let (cancel, mut receive_cancel) = mpsc::channel(1);
        let (note_changed, _) = mpsc::channel(1);
        let cleaned_up = Arc::new(AtomicBool::new(false));
        let observed_cleanup = Arc::clone(&cleaned_up);
        let task = tokio::spawn(async move {
            receive_cancel.recv().await;
            tokio::task::yield_now().await;
            observed_cleanup.store(true, Ordering::Relaxed);
        });

        LiveTask {
            cancel,
            note_changed,
            task,
        }
        .stop_and_wait()
        .await;

        assert!(cleaned_up.load(Ordering::Relaxed));
    }
}
