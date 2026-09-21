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

/// The facts a shell gathers before asking what happens to the open note.
/// Field-for-field the engine's `OpenNoteFacts`; see that type for what each
/// one means.
#[derive(uniffi::Record)]
pub struct OpenNoteFacts {
    pub base: String,
    pub draft: String,
    pub disk: Option<String>,
    pub renamed_to: Option<String>,
    pub editor_focused: bool,
    pub edited_during_cycle: bool,
}

/// Why a draft is being kept, so each shell says it in its own words.
#[derive(uniffi::Enum)]
pub enum KeepDraftReason {
    PeerDeleted,
    Diverged,
    Converged,
}

/// The single verdict on the open note (CONTEXT.md: open-note disposition).
/// Shells render it the way they already render a flush disposition; they
/// never decide it (ADR-0001).
#[derive(uniffi::Enum)]
pub enum OpenNoteDisposition {
    Leave,
    Adopt {
        content: String,
    },
    DeferAdopt,
    FollowRename {
        to_id: String,
    },
    KeepDraft {
        base: String,
        reason: KeepDraftReason,
    },
    Close,
}

/// THE open-note verb. Pure and total: a shell gathers its editor state plus
/// one disk read, calls this, and applies the answer with a single
/// re-validation that it is still on the same note.
#[uniffi::export]
pub fn classify_open_note(facts: OpenNoteFacts) -> OpenNoteDisposition {
    sync::classify_open_note(sync::OpenNoteFacts {
        base: facts.base,
        draft: facts.draft,
        disk: facts.disk,
        renamed_to: facts.renamed_to,
        editor_focused: facts.editor_focused,
        edited_during_cycle: facts.edited_during_cycle,
    })
    .into()
}

impl From<sync::OpenNoteDisposition> for OpenNoteDisposition {
    fn from(disposition: sync::OpenNoteDisposition) -> Self {
        match disposition {
            sync::OpenNoteDisposition::Leave => Self::Leave,
            sync::OpenNoteDisposition::Adopt { content } => Self::Adopt { content },
            sync::OpenNoteDisposition::DeferAdopt => Self::DeferAdopt,
            sync::OpenNoteDisposition::FollowRename { to_id } => Self::FollowRename { to_id },
            sync::OpenNoteDisposition::KeepDraft { base, reason } => Self::KeepDraft {
                base,
                reason: match reason {
                    sync::KeepDraftReason::PeerDeleted => KeepDraftReason::PeerDeleted,
                    sync::KeepDraftReason::Diverged => KeepDraftReason::Diverged,
                    sync::KeepDraftReason::Converged => KeepDraftReason::Converged,
                },
            },
            sync::OpenNoteDisposition::Close => Self::Close,
        }
    }
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
            // Deliberately folded into `Io` rather than given its own variant:
            // a new `SyncError` case is a UniFFI contract change that needs
            // regenerated Swift AND Kotlin bindings plus a branch in both
            // hosts' error rendering, and the sentence itself already survives
            // in the payload. `docs/spec/sync.md` carries the gap for naming it
            // natively. Desktop is unaffected — it stringifies `SyncErrorKind`
            // directly and shows the sentence verbatim.
            SyncErrorKind::VaultMissing(message) => Self::Io(message),
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

    // Built from `default()` and then filled in, rather than with a struct
    // literal: `SyncSummary` carries an engine-internal `pub(crate) decisions`
    // field for the instance journal that this crate cannot name.
    fn engine_summary() -> sync::SyncSummary {
        let mut summary = sync::SyncSummary::default();
        summary.uploaded = 1;
        summary.downloaded = 2;
        summary.deleted = 3;
        summary.conflicts = 4;
        summary.local_writes_applied = 5;
        summary.failures = vec![sync::SyncFailure {
            filename: "note.md".to_owned(),
            kind: sync::FailureKind::Upload,
            status_code: Some(500),
            // Journal-only: the projection below must NOT carry this.
            detail: Some("engine-internal cause".to_owned()),
        }];
        summary.updated_ids = vec!["updated".to_owned()];
        summary.deleted_ids = vec!["deleted".to_owned()];
        summary.peer_updated_ids = vec!["peer-updated".to_owned()];
        summary.peer_deleted_ids = vec!["peer-deleted".to_owned()];
        summary.renamed = vec![sync::RenamePair {
            from_id: "old".to_owned(),
            to_id: "new".to_owned(),
        }];
        summary
    }

    /// The projection is lossless: every semantic field the engine computes
    /// reaches the native shells. For eight months it carried only counters,
    /// so iOS and Android could not scope a refresh or follow a reported
    /// rename and fell back to a whole-vault rescan after every cycle. A new
    /// engine field must appear here (and in the desktop contract) or this
    /// destructuring stops compiling.
    ///
    /// The trailing `..` covers only `SyncSummary`'s `pub(crate) decisions`
    /// field, which this crate cannot name. It does mean a newly added engine
    /// field no longer breaks this pattern, so the exhaustiveness tripwire now
    /// lives where every field IS nameable:
    /// `futo_notes_sync::sync::outcome::summary_shape_tests`.
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
            ..
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
