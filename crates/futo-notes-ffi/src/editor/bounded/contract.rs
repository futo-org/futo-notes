use std::sync::Arc;

use super::super::{
    EditorAffinity, EditorBlockDescription, EditorByteRange, EditorLinkDescription,
    EditorRecoveryStatus, EditorSemanticRun, EditorSessionError, EditorSourceByteRange,
    NativeEditorSession,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedCursor {
    pub token: u64,
    pub incarnation: u64,
    pub revision: u64,
    pub generation: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorProjectionContinuation {
    pub id: u64,
    pub cursor: EditorBoundedCursor,
}

/// Explicit core work only. Entry and materialization are proportional; this
/// excludes Rope internals, native conversion and foreign binding allocations.
#[derive(Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedWork {
    pub inspected_source_bytes: u64,
    pub input_bytes: u64,
    pub parsed_source_bytes: u64,
    pub copied_bytes: u64,
    pub metadata_items: u64,
    pub retired_history_records: u64,
    pub retired_history_payload_bytes: u64,
    pub returned_text_bytes: u64,
    pub returned_records: u64,
}

/// Rust output conversion, separately from engine work. Records count converted domain
/// wire-record values (including nested values, excluding this accounting
/// record); allocated bytes count requested new Vec element storage. Strings
/// move except explicit accepted-source copying. UniFFI lowering/lifting and
/// foreign allocation are excluded and may be proportional to returned output.
#[derive(Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedConversionWork {
    pub records: u64,
    pub allocated_vector_bytes: u64,
    pub copied_text_bytes: u64,
    pub moved_text_bytes: u64,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedWorkReport {
    pub work: EditorBoundedWork,
    pub conversion: EditorBoundedConversionWork,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedSourceChange {
    pub range: EditorSourceByteRange,
    pub inserted_bytes: u64,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCodeIdentity {
    pub source: EditorSourceByteRange,
    pub display: EditorByteRange,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCodeFragment {
    pub owner: u64,
    pub range: EditorByteRange,
    pub language: Option<String>,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedCodeProjection {
    pub range: EditorByteRange,
    pub text: String,
    pub identity: EditorCodeIdentity,
    pub block: EditorCodeFragment,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedChange {
    pub previous: EditorBoundedCursor,
    pub cursor: EditorBoundedCursor,
    pub range: EditorByteRange,
    pub inserted: String,
    pub selection: EditorByteRange,
    pub affinity: EditorAffinity,
    pub projection: EditorBoundedCodeProjection,
    pub source_change: EditorBoundedSourceChange,
    pub continuation: Option<EditorProjectionContinuation>,
    pub work: EditorBoundedWork,
    pub conversion: EditorBoundedConversionWork,
}
#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum EditorBoundedMapKind {
    Literal,
    Atom,
    Hidden,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedMap {
    pub source: EditorSourceByteRange,
    pub display: EditorByteRange,
    pub kind: EditorBoundedMapKind,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedBlock {
    pub description: EditorBlockDescription,
    pub source_owner: Option<u64>,
    pub continues_before: bool,
    pub continues_after: bool,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedMeaning {
    pub range: EditorByteRange,
    pub text: String,
    pub mapping: Vec<EditorBoundedMap>,
    pub runs: Vec<EditorSemanticRun>,
    pub blocks: Vec<EditorBoundedBlock>,
    pub links: Vec<EditorLinkDescription>,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedProgressChange {
    pub previous: EditorBoundedCursor,
    pub cursor: EditorBoundedCursor,
    pub range: EditorByteRange,
    pub inserted: String,
    pub selection: EditorByteRange,
    pub affinity: EditorAffinity,
    pub source_change: Option<EditorBoundedSourceChange>,
    pub source_footprint: EditorSourceByteRange,
    pub projection: EditorBoundedMeaning,
    pub continuation: Option<EditorProjectionContinuation>,
    pub work: EditorBoundedWork,
    pub conversion: EditorBoundedConversionWork,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBoundedProgressStatus {
    pub previous: EditorBoundedCursor,
    pub cursor: EditorBoundedCursor,
    pub selection: EditorByteRange,
    pub affinity: EditorAffinity,
    pub continuation: Option<EditorProjectionContinuation>,
    pub work: EditorBoundedWork,
    pub conversion: EditorBoundedConversionWork,
}
#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum EditorBoundedProgress {
    Change {
        change: Box<EditorBoundedProgressChange>,
    },
    Status {
        status: Box<EditorBoundedProgressStatus>,
    },
}
#[derive(Debug, uniffi::Record)]
pub struct EditorBoundedSourceSnapshot {
    pub source: String,
    pub revision: u64,
    pub recovery: EditorRecoveryStatus,
    pub reset_required: bool,
    pub deleted: bool,
    pub conversion: EditorBoundedConversionWork,
}
#[derive(uniffi::Record)]
pub struct EditorBoundedFullHandoff {
    pub session: Arc<NativeEditorSession>,
    pub work: EditorBoundedWork,
    pub conversion: EditorBoundedConversionWork,
}

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum EditorBoundedError {
    #[error("bounded editor session unavailable")]
    Unavailable,
    #[error("invalid Unicode scalar")]
    InvalidScalar,
    #[error("bounded operation unsupported")]
    Unsupported,
    #[error("stale bounded cursor")]
    StaleCursor,
    #[error("bounded editor mode reset required")]
    ModeResetRequired,
    #[error("bounded editor: {error}")]
    Session { error: EditorSessionError },
}
impl From<EditorSessionError> for EditorBoundedError {
    fn from(error: EditorSessionError) -> Self {
        Self::Session { error }
    }
}
impl From<futo_notes_store::EditorStoreError> for EditorBoundedError {
    fn from(error: futo_notes_store::EditorStoreError) -> Self {
        use futo_notes_editor::BoundedError as B;
        use futo_notes_store::EditorStoreError as E;
        match error {
            E::Bounded(B::Unsupported) => Self::Unsupported,
            E::Bounded(B::StaleCursor) => Self::StaleCursor,
            E::Bounded(B::Editor(error)) => Self::Session {
                error: error.into(),
            },
            E::ModeResetRequired => Self::ModeResetRequired,
            error => Self::Session {
                error: error.into(),
            },
        }
    }
}
