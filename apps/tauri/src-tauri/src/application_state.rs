//! The complete long-lived state of the desktop application adapter.

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) watcher: crate::filesystem_watcher::WatcherState,
    pub(crate) search: crate::search_commands::SearchState,
    pub(crate) sync: futo_notes_sync::SyncSession,
}
