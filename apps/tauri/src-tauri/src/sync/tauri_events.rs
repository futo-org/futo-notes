//! Translation from shared sync callbacks to stable Tauri events.

use futo_notes_sync::SyncSessionListener;
use tauri::{AppHandle, Emitter};

pub(crate) struct TauriSyncListener {
    pub(crate) app: AppHandle,
}

impl SyncSessionListener for TauriSyncListener {
    fn on_synced(&self, summary: futo_notes_sync::SyncSummary) {
        let _ = self.app.emit(
            "sync:live-synced",
            super::frontend_contract::SyncSummary::from(&summary),
        );
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
