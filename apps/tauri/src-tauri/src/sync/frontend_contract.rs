//! Stable serialization contract between the frontend and Rust sync adapter.
//!
//! Field names and event payload shapes in this module are an external IPC
//! contract. The orchestration module consumes these types but does not own
//! their serialization policy.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeConnectInput {
    pub(crate) server_url: String,
    pub(crate) password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeConnectOutput {
    pub(crate) user_id: String,
    pub(crate) collection_id: String,
    pub(crate) token: String,
    pub(crate) auth_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eeResumeInput {
    pub(crate) server_url: String,
    pub(crate) token: String,
    pub(crate) user_id: String,
    pub(crate) collection_id: String,
    pub(crate) password: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFailure {
    pub(crate) filename: String,
    pub(crate) kind: String,
    pub(crate) status_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
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
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests for the frontend sync contract.
    use super::*;
    use futo_notes_sync::{ConnectedState, E2eeObjectMapEntry};
    use std::collections::HashMap;

    fn connected_state() -> ConnectedState {
        let mut object_map = HashMap::new();
        object_map.insert(
            "alpha.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".into(),
                version: 2,
                blob_key: "bkA".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        ConnectedState {
            base_url: "http://x".into(),
            token: "tok".into(),
            user_id: "uX".into(),
            collection_id: "cY".into(),
            vault_key: [1u8; 32],
            object_map,
            max_version: 12,
            pull_cursor: 12,
            oversize_skip: HashMap::new(),
        }
    }

    #[test]
    fn disconnected_status_has_stable_defaults() {
        let status = E2eeStatusOutput::from_snapshot(None);
        assert!(!status.connected);
        assert_eq!(status.max_version, 0);
        assert_eq!(status.object_count, 0);
    }

    #[test]
    fn connected_status_projects_session_fields() {
        let status = E2eeStatusOutput::from_snapshot(Some(connected_state()));
        assert!(status.connected);
        assert_eq!(status.max_version, 12);
        assert_eq!(status.object_count, 1);
        assert_eq!(status.collection_id.as_deref(), Some("cY"));
    }

    #[test]
    fn wire_shapes_remain_camel_case() {
        let connect: E2eeConnectInput =
            serde_json::from_str(r#"{"serverUrl":"http://x","password":"p"}"#).unwrap();
        assert_eq!(connect.server_url, "http://x");
        let resume: E2eeResumeInput = serde_json::from_str(
            r#"{"serverUrl":"u","token":"t","userId":"id","collectionId":"c","password":"p"}"#,
        )
        .unwrap();
        assert_eq!(resume.user_id, "id");
        let summary = SyncSummary {
            uploaded: 1,
            downloaded: 2,
            deleted: 3,
            conflicts: 4,
            local_writes_applied: 2,
            failures: vec![SyncFailure {
                filename: "note.md".into(),
                kind: "upload".into(),
                status_code: Some(500),
            }],
            failure_message: Some("failure".into()),
            updated_ids: vec!["a".into()],
            deleted_ids: vec!["b".into()],
            peer_updated_ids: vec!["c".into()],
            peer_deleted_ids: vec!["d".into()],
            renamed: vec![RenamePair {
                from_id: "old".into(),
                to_id: "new".into(),
            }],
        };
        let json = serde_json::to_string(&summary).unwrap();
        for key in [
            "updatedIds",
            "peerUpdatedIds",
            "peerDeletedIds",
            "fromId",
            "toId",
            "failureMessage",
            "statusCode",
            "localWritesApplied",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key}: {json}"
            );
        }
    }
}
