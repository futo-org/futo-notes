//! The complete long-lived state of the desktop application adapter.

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) watcher: crate::filesystem_watcher::WatcherState,
    pub(crate) notes: crate::local_notes::NoteStoreState,
    /// The note attached to the text-first editor page, if any.
    pub(crate) editor: std::sync::Arc<crate::editor_host::EditorHostState>,
    pub(crate) sync: futo_notes_sync::SyncSession,
    pub(crate) hosted: crate::sync::hosted_commands::HostedSetupState,
    /// A `futonotes://` outcome waiting for the shell to paint (M1).
    pub(crate) license: crate::license::LicenseLinkInbox,
}
