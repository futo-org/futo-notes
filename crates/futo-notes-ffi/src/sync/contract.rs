use futo_notes_sync::{self as sync, SyncErrorKind};

#[derive(uniffi::Record)]
pub struct ConnectInfo {
    pub user_id: String,
    pub collection_id: String,
    pub auth_mode: String,
}

/// One cycle's report, projected losslessly from the engine's
/// `futo_notes_sync::SyncSummary`. Every semantic field the engine computes
/// reaches the native shells, so a shell never has to re-derive what changed
/// from counts (ADR-0001: the record carries the engine's answer). The desktop
/// adapter projects the identical set — see
/// `apps/tauri/src-tauri/src/sync/frontend_contract.rs`.
#[derive(uniffi::Record)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    /// Count of note files this cycle wrote to the local notes tree.
    pub local_writes_applied: u32,
    pub failures: Vec<SyncFailure>,
    /// Render verbatim; Rust owns the cross-shell failure wording.
    pub failure_message: Option<String>,
    /// Note ids this cycle wrote to the local tree, from any source.
    pub updated_ids: Vec<String>,
    /// Note ids this cycle removed from the local tree, from any source.
    pub deleted_ids: Vec<String>,
    /// The subset of `updated_ids` that came from a peer rather than this
    /// device — what a shell must re-read into an open editor.
    pub peer_updated_ids: Vec<String>,
    /// The subset of `deleted_ids` that came from a peer.
    pub peer_deleted_ids: Vec<String>,
    /// Renames the engine PERFORMED, reported as such at the moment it
    /// relocated each note (collision placements included). Shells follow
    /// reported renames; they never infer one from id patterns (CONTEXT.md:
    /// rename intent).
    pub renamed: Vec<RenamePair>,
}

/// One reported rename: the note left `from_id` and now lives at `to_id`.
#[derive(uniffi::Record)]
pub struct RenamePair {
    pub from_id: String,
    pub to_id: String,
}

#[derive(uniffi::Record)]
pub struct SyncFailure {
    pub filename: String,
    /// Stable sync-engine wire identifier.
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
            updated_ids: summary.updated_ids,
            deleted_ids: summary.deleted_ids,
            peer_updated_ids: summary.peer_updated_ids,
            peer_deleted_ids: summary.peer_deleted_ids,
            renamed: summary
                .renamed
                .into_iter()
                .map(|rename| RenamePair {
                    from_id: rename.from_id,
                    to_id: rename.to_id,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_summary() -> sync::SyncSummary {
        sync::SyncSummary {
            uploaded: 1,
            downloaded: 2,
            deleted: 3,
            conflicts: 4,
            local_writes_applied: 5,
            failures: vec![sync::SyncFailure {
                filename: "note.md".to_owned(),
                kind: sync::FailureKind::Upload,
                status_code: Some(500),
            }],
            updated_ids: vec!["updated".to_owned()],
            deleted_ids: vec!["deleted".to_owned()],
            peer_updated_ids: vec!["peer-updated".to_owned()],
            peer_deleted_ids: vec!["peer-deleted".to_owned()],
            renamed: vec![sync::RenamePair {
                from_id: "old".to_owned(),
                to_id: "new".to_owned(),
            }],
        }
    }

    /// The projection is lossless: every semantic field the engine computes
    /// reaches the native shells. For eight months it carried only counters,
    /// so iOS and Android could not scope a refresh or follow a reported
    /// rename and fell back to a whole-vault rescan after every cycle. A new
    /// engine field must appear here (and in the desktop contract) or this
    /// destructuring stops compiling.
    #[test]
    fn projection_carries_every_engine_field() {
        let sync::SyncSummary {
            uploaded,
            downloaded,
            deleted,
            conflicts,
            local_writes_applied,
            failures,
            updated_ids,
            deleted_ids,
            peer_updated_ids,
            peer_deleted_ids,
            renamed,
        } = engine_summary();

        let projected = SyncSummary::from(engine_summary());

        assert_eq!(projected.uploaded, uploaded);
        assert_eq!(projected.downloaded, downloaded);
        assert_eq!(projected.conflicts, conflicts);
        assert_eq!(projected.deleted, deleted);
        assert_eq!(projected.local_writes_applied, local_writes_applied);
        assert_eq!(projected.failures.len(), failures.len());
        assert_eq!(projected.failures[0].kind, "upload");
        assert_eq!(projected.updated_ids, updated_ids);
        assert_eq!(projected.deleted_ids, deleted_ids);
        assert_eq!(projected.peer_updated_ids, peer_updated_ids);
        assert_eq!(projected.peer_deleted_ids, peer_deleted_ids);
        assert_eq!(projected.renamed.len(), renamed.len());
        assert_eq!(projected.renamed[0].from_id, renamed[0].from_id);
        assert_eq!(projected.renamed[0].to_id, renamed[0].to_id);
    }

    /// Rust owns the cross-shell failure wording; the shells render it.
    #[test]
    fn projection_precomputes_the_shared_failure_message() {
        let projected = SyncSummary::from(engine_summary());
        assert_eq!(
            projected.failure_message.as_deref(),
            Some("1 change couldn't reach the server (HTTP 500)")
        );
    }
}
