use std::sync::Arc;

use futo_notes_sync::{self as sync, SyncSessionListener};

use super::SyncSummary;

/// Live-sync callbacks run on Tokio workers, so native implementations must marshal UI work to
/// their main thread and avoid blocking the callback.
#[uniffi::export(callback_interface)]
pub trait SyncEventListener: Send + Sync {
    fn on_synced(&self, summary: SyncSummary);
    fn on_connected(&self);
    fn on_error(&self, message: String);
    fn on_stopped(&self);
}

struct FfiListener(Arc<dyn SyncEventListener>);

impl SyncSessionListener for FfiListener {
    fn on_synced(&self, summary: sync::SyncSummary) {
        self.0.on_synced(summary.into());
    }

    fn on_connected(&self) {
        self.0.on_connected();
    }

    fn on_error(&self, message: String) {
        self.0.on_error(message);
    }

    fn on_stopped(&self) {
        self.0.on_stopped();
    }
}

pub(crate) fn session_listener(
    listener: Box<dyn SyncEventListener>,
) -> Arc<dyn SyncSessionListener> {
    let listener: Arc<dyn SyncEventListener> = Arc::from(listener);
    Arc::new(FfiListener(listener))
}
