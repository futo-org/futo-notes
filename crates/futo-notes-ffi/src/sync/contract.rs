use futo_notes_sync::{self as sync, SyncErrorKind};

#[derive(uniffi::Record)]
pub struct ConnectInfo {
    pub user_id: String,
    pub collection_id: String,
    pub auth_mode: String,
}

#[derive(uniffi::Record)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    /// Count of note files this cycle wrote to the local notes tree.
    pub local_writes_applied: u32,
    /// Per-item failures use the canonical sync-engine wire kinds.
    pub failures: Vec<SyncFailure>,
    /// Canonical user-facing failure text, or `None` for a clean cycle.
    pub failure_message: Option<String>,
}

#[derive(uniffi::Record)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: String,
    pub status_code: Option<u16>,
}

#[derive(uniffi::Record)]
pub struct SyncStatus {
    pub connected: bool,
    pub server_url: Option<String>,
    pub user_id: Option<String>,
    pub collection_id: Option<String>,
    pub max_version: u64,
    pub object_count: u32,
}

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum SyncError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("{0}")]
    CollectionGone(String),
    #[error("not connected")]
    NotConnected,
}

impl From<SyncErrorKind> for SyncError {
    fn from(error: SyncErrorKind) -> Self {
        match error {
            SyncErrorKind::Http(message) => Self::Http(message),
            SyncErrorKind::Crypto(message) => Self::Crypto(message),
            SyncErrorKind::Io(message) => Self::Io(message),
            SyncErrorKind::Auth(message) => Self::Auth(message),
            SyncErrorKind::CollectionGone(message) => Self::CollectionGone(message),
            SyncErrorKind::NotConnected => Self::NotConnected,
        }
    }
}

impl From<sync::SyncSummary> for SyncSummary {
    fn from(summary: sync::SyncSummary) -> Self {
        Self {
            uploaded: summary.uploaded,
            downloaded: summary.downloaded,
            deleted: summary.deleted,
            conflicts: summary.conflicts,
            local_writes_applied: summary.local_writes_applied,
            failure_message: summary.failure_message(),
            failures: summary
                .failures
                .into_iter()
                .map(|failure| SyncFailure {
                    filename: failure.filename,
                    kind: failure.kind.as_str().to_owned(),
                    status_code: failure.status_code,
                })
                .collect(),
        }
    }
}
