//! Stable serialization contract between the frontend and Rust sync adapter.
//!
//! Field names and event payload shapes in this module are an external IPC
//! contract. The orchestration module consumes these types but does not own
//! their serialization policy.

use serde::{Deserialize, Serialize};

mod hosted;
mod open_note;
#[cfg(test)]
mod tests;

pub(crate) use hosted::*;
pub(crate) use open_note::*;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeConnectInput {
    pub(crate) server_url: String,
    pub(crate) password: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeConnectOutput {
    pub(crate) user_id: String,
    pub(crate) collection_id: String,
    pub(crate) token: String,
    pub(crate) auth_mode: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeResumeInput {
    pub(crate) server_url: String,
    pub(crate) token: String,
    pub(crate) user_id: String,
    pub(crate) collection_id: String,
    pub(crate) password: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeStatusOutput {
    pub(crate) connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_id: Option<String>,
    pub(crate) max_version: u64,
    pub(crate) object_count: usize,
}

impl E2eeStatusOutput {
    pub(crate) fn from_snapshot(snapshot: Option<futo_notes_sync::ConnectedState>) -> Self {
        match snapshot {
            None => Self {
                connected: false,
                server_url: None,
                user_id: None,
                collection_id: None,
                max_version: 0,
                object_count: 0,
            },
            Some(state) => Self {
                connected: true,
                server_url: Some(state.base_url),
                user_id: Some(state.user_id),
                collection_id: Some(state.collection_id),
                max_version: state.max_version,
                object_count: state.object_map.len(),
            },
        }
    }
}

#[derive(Debug, Default, Serialize, Clone)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncSummary {
    pub(crate) uploaded: usize,
    pub(crate) downloaded: usize,
    pub(crate) deleted: usize,
    pub(crate) conflicts: usize,
    /// Count of note files this cycle wrote to the local tree (F2). Desktop
    /// already reloads on `updated_ids`, so it doesn't gate on this; it is
    /// carried for wire parity with the native FFI summary.
    pub(crate) local_writes_applied: usize,
    pub(crate) failures: Vec<SyncFailure>,
    pub(crate) failure_message: Option<String>,
    pub(crate) updated_ids: Vec<String>,
    pub(crate) deleted_ids: Vec<String>,
    pub(crate) peer_updated_ids: Vec<String>,
    pub(crate) peer_deleted_ids: Vec<String>,
    pub(crate) renamed: Vec<RenamePair>,
    /// Set when the server refused this cycle's writes. The shells turn it
    /// into a banner with an action; Rust decides which one, including the
    /// precedence when both a lapse and a full vault are true
    /// (`futo_notes_sync::WriteRefusal`).
    pub(crate) write_refusal: Option<WriteRefusalOutput>,
}

/// `futo_notes_sync::WriteRefusal`, projected. A tagged union rather than a
/// bare string so the frontend cannot spell a case that does not exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) enum WriteRefusalOutput {
    SubscriptionRequired,
    QuotaExceeded,
}

impl From<futo_notes_sync::WriteRefusal> for WriteRefusalOutput {
    fn from(refusal: futo_notes_sync::WriteRefusal) -> Self {
        match refusal {
            futo_notes_sync::WriteRefusal::SubscriptionRequired => Self::SubscriptionRequired,
            futo_notes_sync::WriteRefusal::QuotaExceeded => Self::QuotaExceeded,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFailure {
    pub(crate) filename: String,
    pub(crate) kind: String,
    pub(crate) status_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenamePair {
    pub(crate) from_id: String,
    pub(crate) to_id: String,
}

impl From<&futo_notes_sync::SyncSummary> for SyncSummary {
    fn from(summary: &futo_notes_sync::SyncSummary) -> Self {
        Self {
            uploaded: summary.uploaded as usize,
            downloaded: summary.downloaded as usize,
            deleted: summary.deleted as usize,
            conflicts: summary.conflicts as usize,
            local_writes_applied: summary.local_writes_applied as usize,
            failure_message: summary.failure_message(),
            failures: summary
                .failures
                .iter()
                .map(|failure| SyncFailure {
                    filename: failure.filename.clone(),
                    kind: failure.kind.as_str().to_owned(),
                    status_code: failure.status_code,
                })
                .collect(),
            updated_ids: summary.updated_ids.clone(),
            deleted_ids: summary.deleted_ids.clone(),
            peer_updated_ids: summary.peer_updated_ids.clone(),
            peer_deleted_ids: summary.peer_deleted_ids.clone(),
            renamed: summary
                .renamed
                .iter()
                .map(|rename| RenamePair {
                    from_id: rename.from_id.clone(),
                    to_id: rename.to_id.clone(),
                })
                .collect(),
            write_refusal: summary.write_refusal.map(WriteRefusalOutput::from),
        }
    }
}
