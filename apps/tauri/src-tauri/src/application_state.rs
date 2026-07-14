//! The complete long-lived state of the desktop application adapter.

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) watcher: crate::filesystem_watcher::WatcherState,
    pub(crate) notes: crate::local_notes::NoteStoreState,
    pub(crate) sync: futo_notes_sync::SyncSession,
}
