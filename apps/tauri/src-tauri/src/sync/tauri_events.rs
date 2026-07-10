//! Translation from shared sync callbacks to stable Tauri events.

use futo_notes_sync::live::SyncSessionListener;
use tauri::{AppHandle, Emitter};

pub(crate) struct TauriSyncListener {
    pub(crate) app: AppHandle,
}

impl SyncSessionListener for TauriSyncListener {
    fn on_synced(&self, _summary: futo_notes_sync::SyncSummary) {
        // `sync:live-synced` carries the wire summary and is emitted by the
        // cycle closure that still has access to that projection.
    }

    fn on_connected(&self) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({ "live": true, "status": "connected" }),
        );
    }

    fn on_error(&self, message: String) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({
                "live": false,
                "status": "reconnecting",
                "message": message,
            }),
        );
    }

    fn on_cycle_error(&self, message: String) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({
                "live": true,
                "status": "cycle-error",
                "message": message,
            }),
        );
    }

    fn on_stopped(&self) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({ "live": false, "status": "stopped" }),
        );
    }
}
