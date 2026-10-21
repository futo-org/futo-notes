//! Where normalized vault changes go: the app's `fs:change` event.

use super::*;

/// Where the processor reports normalized vault changes: the app's
/// [`EventSink`], or a recorder in tests.
pub(super) trait ChangeSink: Clone + Send + Sync + 'static {
    fn change(&self, kind: &str, relative_path: &str);
    fn rename(&self, from: &str, to: &str);
}

#[derive(Clone)]
pub(super) struct EventSink {
    pub(super) app: AppHandle,
    pub(super) suppression: WatcherSuppression,
}

impl ChangeSink for EventSink {
    fn change(&self, kind: &str, relative_path: &str) {
        if self.suppression.consume(relative_path) {
            return;
        }
        let change = match kind {
            "unlink" => futo_notes_store::FileChange::Removed(relative_path.to_owned()),
            _ => futo_notes_store::FileChange::Changed(relative_path.to_owned()),
        };
        self.app.state::<AppState>().notes.observe(change);
        let _ = self.app.emit(
            "fs:change",
            serde_json::json!({ "type": kind, "filename": relative_path }),
        );
    }

    fn rename(&self, from: &str, to: &str) {
        if self.suppression.consume_rename(from, to) {
            return;
        }
        self.app
            .state::<AppState>()
            .notes
            .observe(futo_notes_store::FileChange::Renamed {
                from: from.to_owned(),
                to: to.to_owned(),
            });
        let _ = self.app.emit(
            "fs:change",
            serde_json::json!({ "type": "rename", "filename": to, "from": from }),
        );
    }
}
