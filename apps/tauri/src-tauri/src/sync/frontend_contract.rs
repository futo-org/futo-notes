//! Stable serialization contract between the frontend and Rust sync adapter.
//!
//! Field names and event payload shapes in this module are an external IPC
//! contract. The orchestration module consumes these types but does not own
//! their serialization policy.

use serde::{Deserialize, Serialize};

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

/// The editor facts supplied by the frontend. The adapter gathers the
/// authoritative disk value before asking the engine for a verdict.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenNoteRequestInput {
    pub(crate) id: String,
    pub(crate) base: String,
    pub(crate) draft: String,
    pub(crate) renamed_to: Option<String>,
    pub(crate) editor_focused: bool,
    pub(crate) edited_during_cycle: bool,
}

impl OpenNoteRequestInput {
    pub(crate) fn with_disk(self, disk: Option<String>) -> futo_notes_sync::OpenNoteFacts {
        futo_notes_sync::OpenNoteFacts {
            base: self.base,
            draft: self.draft,
            disk,
            renamed_to: self.renamed_to,
            editor_focused: self.editor_focused,
            edited_during_cycle: self.edited_during_cycle,
        }
    }
}

/// The engine's verdict on the open note, tagged the same way a flush
/// disposition is so the frontend renders both through one shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum OpenNoteDispositionOutput {
    Leave,
    Adopt {
        content: String,
    },
    DeferAdopt,
    #[serde(rename_all = "camelCase")]
    FollowRename {
        to_id: String,
    },
    #[serde(rename_all = "camelCase")]
    KeepDraft {
        base: String,
        reason: KeepDraftReasonOutput,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeepDraftReasonOutput {
    PeerDeleted,
    Diverged,
    Converged,
}

impl From<futo_notes_sync::OpenNoteDisposition> for OpenNoteDispositionOutput {
    fn from(disposition: futo_notes_sync::OpenNoteDisposition) -> Self {
        use futo_notes_sync::{KeepDraftReason, OpenNoteDisposition};
        match disposition {
            OpenNoteDisposition::Leave => Self::Leave,
            OpenNoteDisposition::Adopt { content } => Self::Adopt { content },
            OpenNoteDisposition::DeferAdopt => Self::DeferAdopt,
            OpenNoteDisposition::FollowRename { to_id } => Self::FollowRename { to_id },
            OpenNoteDisposition::KeepDraft { base, reason } => Self::KeepDraft {
                base,
                reason: match reason {
                    KeepDraftReason::PeerDeleted => KeepDraftReasonOutput::PeerDeleted,
                    KeepDraftReason::Diverged => KeepDraftReasonOutput::Diverged,
                    KeepDraftReason::Converged => KeepDraftReasonOutput::Converged,
                },
            },
            OpenNoteDisposition::Close => Self::Close,
        }
    }
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
    use std::fs;
    use std::path::PathBuf;

    const UPDATE_CONTRACT_ENV: &str = "FUTO_UPDATE_SYNC_CONTRACT";

    fn generated_contract_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/features/sync/syncContract.generated.ts")
    }

    fn render_typescript_contract() -> String {
        use specta::TypeCollection;
        use specta_typescript::{BigIntExportBehavior, Typescript};

        let types = TypeCollection::default()
            .register::<E2eeConnectInput>()
            .register::<E2eeConnectOutput>()
            .register::<E2eeResumeInput>()
            .register::<E2eeStatusOutput>()
            .register::<SyncSummary>()
            .register::<OpenNoteRequestInput>()
            .register::<OpenNoteDispositionOutput>();

        Typescript::default()
            // Tauri serializes u64/usize as JSON numbers; mirror that wire shape.
            .bigint(BigIntExportBehavior::Number)
            .header(
                "// GENERATED FILE — DO NOT EDIT.\n// Source: apps/tauri/src-tauri/src/sync/frontend_contract.rs.\n",
            )
            .export(&types)
            .expect("export sync contract to TypeScript")
    }

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
        let mut state = ConnectedState::new(
            "http://x".into(),
            "tok".into(),
            "uX".into(),
            "cY".into(),
            [1u8; 32],
        );
        state.object_map = object_map;
        state.max_version = 12;
        state.pull_cursor = 12;
        state
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

    /// The desktop projection is lossless, and stays lossless in lockstep with
    /// the UniFFI one: both adapters destructure a fully populated engine
    /// summary, so a new engine field cannot reach one shell family while
    /// silently skipping the other. That asymmetry is exactly what let the
    /// native summary carry only counters for eight months.
    /// Twin: `futo_notes_ffi::sync::contract::projection_carries_every_engine_field`.
    ///
    /// The trailing `..` covers only `SyncSummary`'s `pub(crate) decisions`
    /// field, which this crate cannot name. It does mean a newly added engine
    /// field no longer breaks this pattern, so the exhaustiveness tripwire now
    /// lives where every field IS nameable:
    /// `futo_notes_sync::sync::outcome::summary_shape_tests`.
    #[test]
    fn projection_carries_every_engine_field() {
        // Built from `default()` and then filled in, rather than with a struct
        // literal, for the same `pub(crate) decisions` reason.
        let engine = || {
            let mut summary = futo_notes_sync::SyncSummary::default();
            summary.uploaded = 1;
            summary.downloaded = 2;
            summary.deleted = 3;
            summary.conflicts = 4;
            summary.local_writes_applied = 5;
            summary.failures = vec![futo_notes_sync::SyncFailure {
                filename: "note.md".to_owned(),
                kind: futo_notes_sync::FailureKind::Upload,
                status_code: Some(500),
            }];
            summary.updated_ids = vec!["updated".to_owned()];
            summary.deleted_ids = vec!["deleted".to_owned()];
            summary.peer_updated_ids = vec!["peer-updated".to_owned()];
            summary.peer_deleted_ids = vec!["peer-deleted".to_owned()];
            summary.renamed = vec![futo_notes_sync::RenamePair {
                from_id: "old".to_owned(),
                to_id: "new".to_owned(),
            }];
            summary
        };
        let futo_notes_sync::SyncSummary {
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
        } = engine();

        let projected = SyncSummary::from(&engine());

        assert_eq!(projected.uploaded, uploaded as usize);
        assert_eq!(projected.downloaded, downloaded as usize);
        assert_eq!(projected.deleted, deleted as usize);
        assert_eq!(projected.conflicts, conflicts as usize);
        assert_eq!(projected.local_writes_applied, local_writes_applied as usize);
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

    /// The desktop projection of the open-note verb reaches every arm, and its
    /// wire shape matches the flush disposition's (`{ kind, … }`) so the
    /// frontend renders both through one shape. The decision table itself is
    /// exhaustively tested in `futo-notes-sync::open_note`.
    #[test]
    fn open_note_disposition_projects_every_arm_as_a_tagged_union() {
        use futo_notes_sync::{KeepDraftReason, OpenNoteDisposition};

        let json = |disposition: OpenNoteDisposition| {
            serde_json::to_string(&OpenNoteDispositionOutput::from(disposition)).unwrap()
        };

        assert_eq!(json(OpenNoteDisposition::Leave), r#"{"kind":"leave"}"#);
        assert_eq!(
            json(OpenNoteDisposition::Adopt {
                content: "peer".into()
            }),
            r#"{"kind":"adopt","content":"peer"}"#
        );
        assert_eq!(
            json(OpenNoteDisposition::DeferAdopt),
            r#"{"kind":"deferAdopt"}"#
        );
        assert_eq!(
            json(OpenNoteDisposition::FollowRename {
                to_id: "Note (2)".into()
            }),
            r#"{"kind":"followRename","toId":"Note (2)"}"#
        );
        assert_eq!(
            json(OpenNoteDisposition::KeepDraft {
                base: "peer".into(),
                reason: KeepDraftReason::Diverged,
            }),
            r#"{"kind":"keepDraft","base":"peer","reason":"diverged"}"#
        );
        assert_eq!(json(OpenNoteDisposition::Close), r#"{"kind":"close"}"#);
    }

    /// The frontend's gathered facts survive the camelCase wire hop intact —
    /// a silently-dropped `renamedTo` or `editedDuringCycle` would flip the
    /// verdict rather than fail loudly.
    #[test]
    fn open_note_request_deserializes_from_the_camel_case_wire_shape() {
        let input: OpenNoteRequestInput = serde_json::from_str(
            r#"{"id":"Note","base":"b","draft":"d","renamedTo":"Note (2)",
                "editorFocused":true,"editedDuringCycle":true}"#,
        )
        .unwrap();
        assert_eq!(input.id, "Note");
        let facts = input.with_disk(None);
        assert_eq!(facts.base, "b");
        assert_eq!(facts.draft, "d");
        assert_eq!(facts.disk, None);
        assert_eq!(facts.renamed_to.as_deref(), Some("Note (2)"));
        assert!(facts.editor_focused);
        assert!(facts.edited_during_cycle);
    }

    #[test]
    fn generated_typescript_contract_is_current() {
        let path = generated_contract_path();
        let generated = render_typescript_contract();
        if std::env::var_os(UPDATE_CONTRACT_ENV).is_some() {
            fs::write(&path, generated).expect("write generated sync contract");
            return;
        }

        let current = fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            current,
            generated,
            "{} is stale; run `just sync-contract`",
            path.display()
        );
    }
}
