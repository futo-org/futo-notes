//! The open-note verdict a shell asks for, and how it is worded on the wire.

use serde::{Deserialize, Serialize};

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
