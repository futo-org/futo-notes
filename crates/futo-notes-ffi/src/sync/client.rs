use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_sync::{SyncProgress, SyncSession, SyncSessionListener};

use super::{session_listener, ConnectInfo, SyncError, SyncEventListener, SyncStatus, SyncSummary};

// Native shells have neither watcher suppression nor per-phase progress UI.
fn no_progress(_progress: SyncProgress) {}
fn no_pre_write(_filename: &str) {}

#[derive(uniffi::Object)]
pub struct SyncClient {
    notes_root: PathBuf,
    server_url: String,
    session: SyncSession,
}

#[uniffi::export(async_runtime = "tokio")]
impl SyncClient {
    #[uniffi::constructor]
    pub fn new(notes_root: String, server_url: String) -> Arc<Self> {
        Arc::new(Self {
            notes_root: PathBuf::from(notes_root),
            server_url,
            session: SyncSession::new(),
        })
    }

    pub async fn connect(&self, password: String) -> Result<ConnectInfo, SyncError> {
        let connected = self
            .session
            .connect(&self.notes_root, &self.server_url, &password)
            .await?;
        Ok(ConnectInfo {
            user_id: connected.user_id,
            collection_id: connected.collection_id,
            auth_mode: connected.auth_mode.to_owned(),
        })
    }

    /// Runs a serialized push-first cycle without holding the status lock during network I/O.
    pub async fn sync_now(&self) -> Result<SyncSummary, SyncError> {
        self.session
            .sync(&self.notes_root, &no_progress, &no_pre_write)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }

    pub fn status(&self) -> SyncStatus {
        match self.session.status() {
            None => SyncStatus {
                connected: false,
                server_url: None,
                user_id: None,
                collection_id: None,
                max_version: 0,
                object_count: 0,
            },
            Some(connected) => SyncStatus {
                connected: true,
                server_url: Some(connected.base_url),
                user_id: Some(connected.user_id),
                collection_id: Some(connected.collection_id),
                max_version: connected.max_version,
                object_count: connected.object_map.len() as u32,
            },
        }
    }

    pub fn note_changed(&self) {
        self.session.note_changed();
    }

    pub async fn start_live(
        self: Arc<Self>,
        listener: Box<dyn SyncEventListener>,
    ) -> Result<(), SyncError> {
        let listener: Arc<dyn SyncSessionListener> = session_listener(listener);
        self.session
            .start_live(self.notes_root.clone(), listener, Arc::new(no_pre_write))
            .await
            .map_err(Into::into)
    }

    pub fn stop_live(&self) {
        self.session.stop_live();
    }

    /// Disconnect drops live cursor state but preserves verified ancestry for safe reconciliation
    /// after reconnect.
    pub async fn disconnect(&self) -> Result<(), SyncError> {
        self.session
            .disconnect(&self.notes_root)
            .await
            .map_err(Into::into)
    }
}
