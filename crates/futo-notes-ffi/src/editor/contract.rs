use futo_notes_editor as editor;
use futo_notes_store as store;

use crate::FlushDraftResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorByteRange {
    pub start: u64,
    pub end: u64,
}

impl From<editor::DisplayRange> for EditorByteRange {
    fn from(value: editor::DisplayRange) -> Self {
        Self {
            start: value.start.0 as u64,
            end: value.end.0 as u64,
        }
    }
}

impl TryFrom<EditorByteRange> for editor::DisplayRange {
    type Error = EditorSessionError;
    fn try_from(value: EditorByteRange) -> Result<Self, Self::Error> {
        Ok(Self {
            start: editor::DisplayOffset(
                usize::try_from(value.start).map_err(|_| EditorSessionError::InvalidRange)?,
            ),
            end: editor::DisplayOffset(
                usize::try_from(value.end).map_err(|_| EditorSessionError::InvalidRange)?,
            ),
        })
    }
}

impl From<editor::DisplayUtf16Range> for EditorUtf16Range {
    fn from(value: editor::DisplayUtf16Range) -> Self {
        Self {
            start: value.start.0 as u64,
            end: value.end.0 as u64,
        }
    }
}

#[derive(Debug, uniffi::Record)]
pub struct EditorSelectionChange {
    pub revision: u64,
    pub selection: EditorByteRange,
    pub affinity: EditorAffinity,
}

impl From<editor::SelectionChange> for EditorSelectionChange {
    fn from(value: editor::SelectionChange) -> Self {
        Self {
            revision: value.revision.0,
            selection: value.selection.into(),
            affinity: value.affinity.into(),
        }
    }
}

/// Display UTF-16 code units; transport width does not depend on native usize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorUtf16Range {
    pub start: u64,
    pub end: u64,
}

impl TryFrom<EditorUtf16Range> for editor::DisplayUtf16Range {
    type Error = EditorSessionError;
    fn try_from(value: EditorUtf16Range) -> Result<Self, Self::Error> {
        Ok(Self {
            start: editor::DisplayUtf16Offset(
                usize::try_from(value.start).map_err(|_| EditorSessionError::InvalidRange)?,
            ),
            end: editor::DisplayUtf16Offset(
                usize::try_from(value.end).map_err(|_| EditorSessionError::InvalidRange)?,
            ),
        })
    }
}

/// The engine determines the affected display range and paragraph semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorParagraphKey {
    Enter,
    ShiftEnter,
    Backspace,
    Delete,
    Tab,
    ShiftTab,
}
impl From<EditorParagraphKey> for editor::ParagraphKey {
    fn from(value: EditorParagraphKey) -> Self {
        match value {
            EditorParagraphKey::Enter => Self::Enter,
            EditorParagraphKey::ShiftEnter => Self::ShiftEnter,
            EditorParagraphKey::Backspace => Self::Backspace,
            EditorParagraphKey::Delete => Self::Delete,
            EditorParagraphKey::Tab => Self::Tab,
            EditorParagraphKey::ShiftTab => Self::ShiftTab,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorBlockCommand {
    Heading { level: u8 },
    Quote,
    Indent,
    Outdent,
    Divider,
    BulletList,
    OrderedList,
    TaskList,
    ToggleTask,
    CodeBlock,
}
impl From<EditorBlockCommand> for editor::BlockCommand {
    fn from(value: EditorBlockCommand) -> Self {
        match value {
            EditorBlockCommand::Heading { level } => Self::Heading(level),
            EditorBlockCommand::Quote => Self::Quote,
            EditorBlockCommand::Indent => Self::Indent,
            EditorBlockCommand::Outdent => Self::Outdent,
            EditorBlockCommand::Divider => Self::Divider,
            EditorBlockCommand::BulletList => Self::BulletList,
            EditorBlockCommand::OrderedList => Self::OrderedList,
            EditorBlockCommand::TaskList => Self::TaskList,
            EditorBlockCommand::ToggleTask => Self::ToggleTask,
            EditorBlockCommand::CodeBlock => Self::CodeBlock,
        }
    }
}

/// The engine owns grouping; native hosts identify isolated user actions and
/// submit only the committed text of a provisional composition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorInputAction {
    Typing,
    Isolated,
    CompositionCommit,
}
impl From<EditorInputAction> for editor::InputAction {
    fn from(value: EditorInputAction) -> Self {
        match value {
            EditorInputAction::Typing => Self::Typing,
            EditorInputAction::Isolated => Self::Isolated,
            EditorInputAction::CompositionCommit => Self::CompositionCommit,
        }
    }
}
#[derive(Debug, uniffi::Record)]
pub struct EditorUtf16Replacement {
    pub range: EditorUtf16Range,
    pub inserted: Vec<u16>,
}
impl TryFrom<EditorUtf16Replacement> for editor::DisplayUtf16Replacement {
    type Error = EditorSessionError;
    fn try_from(value: EditorUtf16Replacement) -> Result<Self, Self::Error> {
        Ok(Self {
            range: value.range.try_into()?,
            inserted: value.inserted,
        })
    }
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorViewChange {
    pub previous_revision: u64,
    pub revision: u64,
    /// Replacement range in the previous display's UTF-8 bytes.
    pub range: EditorByteRange,
    pub inserted: String,
    /// Selection in the resulting display's UTF-8 bytes.
    pub selection: EditorByteRange,
    pub materialized_source_bytes: u64,
    pub inserted_bytes: u64,
    pub parsed_source_bytes: u64,
    pub affinity: EditorAffinity,
    pub projection: EditorProjection,
}

impl From<editor::ViewChange> for EditorViewChange {
    fn from(value: editor::ViewChange) -> Self {
        Self {
            previous_revision: value.previous_revision.0,
            revision: value.revision.0,
            range: value.range.into(),
            inserted: value.inserted,
            selection: value.selection.into(),
            materialized_source_bytes: value.work.materialized_source_bytes as u64,
            inserted_bytes: value.work.inserted_bytes as u64,
            parsed_source_bytes: value.work.parsed_source_bytes as u64,
            affinity: value.affinity.into(),
            projection: value.projection.into(),
        }
    }
}

#[derive(Debug, uniffi::Record)]
pub struct EditorRecoveryStatus {
    pub accepted: u64,
    pub durable: u64,
    pub flush_deadline: Option<std::time::Duration>,
    pub paused: bool,
    pub last_flush_lateness: Option<std::time::Duration>,
}

impl From<store::RecoveryStatus> for EditorRecoveryStatus {
    fn from(value: store::RecoveryStatus) -> Self {
        Self {
            accepted: value.accepted.0,
            durable: value.durable.0,
            flush_deadline: value.flush_deadline,
            paused: value.paused,
            last_flush_lateness: value.last_flush_lateness,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum EditorRecoveryIssueKind {
    TornTail,
    CorruptRecord,
    InvalidEdit,
    SequenceMismatch,
    IdentityMismatch,
    UnsupportedVersion { version: u32 },
    BaseMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorRecoveryIssue {
    pub kind: EditorRecoveryIssueKind,
    pub record: u64,
}

impl From<store::RecoveryIssue> for EditorRecoveryIssue {
    fn from(value: store::RecoveryIssue) -> Self {
        use store::RecoveryIssueKind as K;
        Self {
            record: value.record as u64,
            kind: match value.kind {
                K::TornTail => EditorRecoveryIssueKind::TornTail,
                K::CorruptRecord => EditorRecoveryIssueKind::CorruptRecord,
                K::InvalidEdit => EditorRecoveryIssueKind::InvalidEdit,
                K::SequenceMismatch => EditorRecoveryIssueKind::SequenceMismatch,
                K::IdentityMismatch => EditorRecoveryIssueKind::IdentityMismatch,
                K::UnsupportedVersion { version } => {
                    EditorRecoveryIssueKind::UnsupportedVersion { version }
                }
                K::BaseMismatch => EditorRecoveryIssueKind::BaseMismatch,
            },
        }
    }
}

#[derive(uniffi::Error, thiserror::Error)]
pub enum EditorSessionError {
    #[error("editor session unavailable")]
    Unavailable,
    #[error("stale revision {expected}; current revision {actual}")]
    StaleRevision { expected: u64, actual: u64 },
    #[error("invalid editor range")]
    InvalidRange,
    #[error("invalid UTF-16 input")]
    InvalidText,
    #[error("editor composition is active")]
    CompositionActive,
    #[error("format cannot be represented without changing meaning")]
    UnrepresentableFormat,
    #[error("editor revision exhausted")]
    RevisionExhausted,
    #[error("editor persistence failed: {error}")]
    Persistence { error: String },
    #[error("editor recovery mismatch")]
    RecoveryMismatch,
    #[error("editor open failed: {error}")]
    Open { error: String },
    #[error("editor session already open")]
    SessionAlreadyOpen,
    #[error("editor recovery failed: {error}")]
    Recovery { error: String },
    #[error("editor recovery append failed: {error}")]
    RecoveryAppend { error: String },
    #[error("editor recovery flush failed: {error}")]
    RecoveryFlush { error: String },
    #[error("editor recovery resume failed: {error}")]
    RecoveryResume { error: String },
    #[error("editor recovery paused")]
    RecoveryPaused,
    #[error("editor recovery needs review: {issue:?}")]
    RecoveryNeedsReview { issue: EditorRecoveryIssue },
    #[error("editor checkpoint failed: {error}")]
    Checkpoint { error: String },
    #[error("editor checkpoint pending")]
    CheckpointPending,
    #[error("editor attachment was deleted")]
    SessionDeleted,
    #[error("editor checkpoint committed but needs retry: {error}")]
    CheckpointCommitted {
        result: Box<FlushDraftResult>,
        error: String,
    },
}

impl std::fmt::Debug for EditorSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl From<editor::EditorError> for EditorSessionError {
    fn from(value: editor::EditorError) -> Self {
        use editor::EditorError as E;
        match value {
            E::StaleRevision { expected, actual } => Self::StaleRevision {
                expected: expected.0,
                actual: actual.0,
            },
            E::InvalidRange => Self::InvalidRange,
            E::InvalidText => Self::InvalidText,
            E::CompositionActive => Self::CompositionActive,
            E::RevisionExhausted => Self::RevisionExhausted,
            E::UnrepresentableFormat => Self::UnrepresentableFormat,
            E::Persistence(error) => Self::Persistence { error },
            E::RecoveryMismatch => Self::RecoveryMismatch,
        }
    }
}

impl From<store::EditorStoreError> for EditorSessionError {
    fn from(value: store::EditorStoreError) -> Self {
        use store::EditorStoreError as E;
        match value {
            E::Editor(error) => error.into(),
            E::Open(error) => Self::Open { error },
            E::SessionAlreadyOpen => Self::SessionAlreadyOpen,
            E::Recovery(error) => Self::Recovery { error },
            E::RecoveryAppend(error) => Self::RecoveryAppend { error },
            E::RecoveryFlush(error) => Self::RecoveryFlush { error },
            E::RecoveryResume(error) => Self::RecoveryResume { error },
            E::RecoveryPaused => Self::RecoveryPaused,
            E::RecoveryNeedsReview(issue) => Self::RecoveryNeedsReview {
                issue: issue.into(),
            },
            E::Checkpoint(error) => Self::Checkpoint { error },
            E::CheckpointPending => Self::CheckpointPending,
            E::SessionDeleted => Self::SessionDeleted,
            E::CheckpointCommitted { result, error } => Self::CheckpointCommitted {
                result: Box::new((*result).into()),
                error,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorAffinity {
    Backward,
    Forward,
}
impl From<editor::Affinity> for EditorAffinity {
    fn from(value: editor::Affinity) -> Self {
        match value {
            editor::Affinity::Backward => Self::Backward,
            editor::Affinity::Forward => Self::Forward,
        }
    }
}
impl From<EditorAffinity> for editor::Affinity {
    fn from(value: EditorAffinity) -> Self {
        match value {
            EditorAffinity::Backward => Self::Backward,
            EditorAffinity::Forward => Self::Forward,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorInlineFormat {
    Bold,
    Italic,
    Strike,
    Code,
}
impl From<editor::InlineFormat> for EditorInlineFormat {
    fn from(value: editor::InlineFormat) -> Self {
        match value {
            editor::InlineFormat::Bold => Self::Bold,
            editor::InlineFormat::Italic => Self::Italic,
            editor::InlineFormat::Strike => Self::Strike,
            editor::InlineFormat::Code => Self::Code,
        }
    }
}
impl From<EditorInlineFormat> for editor::InlineFormat {
    fn from(value: EditorInlineFormat) -> Self {
        match value {
            EditorInlineFormat::Bold => Self::Bold,
            EditorInlineFormat::Italic => Self::Italic,
            EditorInlineFormat::Strike => Self::Strike,
            EditorInlineFormat::Code => Self::Code,
        }
    }
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorSemanticRun {
    pub range: EditorByteRange,
    pub formats: Vec<EditorInlineFormat>,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorSourceByteRange {
    pub start: u64,
    pub end: u64,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCorrespondence {
    pub source: EditorSourceByteRange,
    pub display: EditorByteRange,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorProjection {
    pub revision: u64,
    pub range: EditorByteRange,
    pub text: String,
    pub runs: Vec<EditorSemanticRun>,
    pub correspondence: Vec<EditorCorrespondence>,
    pub blocks: Vec<EditorBlockDescription>,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorListDescription {
    pub depth: u64,
    pub number: Option<u64>,
    pub checked: Option<bool>,
    pub first: bool,
}
impl From<editor::ListDescription> for EditorListDescription {
    fn from(value: editor::ListDescription) -> Self {
        Self {
            depth: value.depth as u64,
            number: value.number,
            checked: value.checked,
            first: value.first,
        }
    }
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBlockDescription {
    pub range: EditorByteRange,
    pub heading: u8,
    pub quote_depth: u64,
    pub divider: bool,
    pub list: Option<EditorListDescription>,
    pub code: bool,
    pub language: Option<String>,
}
impl From<editor::ProjectionSlice> for EditorProjection {
    fn from(value: editor::ProjectionSlice) -> Self {
        Self {
            revision: value.revision.0,
            range: value.range.into(),
            text: value.text,
            blocks: value
                .blocks
                .into_iter()
                .map(|block| EditorBlockDescription {
                    range: block.range.into(),
                    heading: block.heading,
                    quote_depth: block.quote_depth as u64,
                    divider: block.divider,
                    list: block.list.map(Into::into),
                    code: block.code,
                    language: block.language,
                })
                .collect(),
            runs: value
                .runs
                .into_iter()
                .map(|run| EditorSemanticRun {
                    range: run.range.into(),
                    formats: run.formats.into_iter().map(Into::into).collect(),
                })
                .collect(),
            correspondence: value
                .correspondence
                .into_iter()
                .map(|item| EditorCorrespondence {
                    source: EditorSourceByteRange {
                        start: item.source.start.0 as u64,
                        end: item.source.end.0 as u64,
                    },
                    display: item.display.into(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorDisplayByteOffset {
    pub offset: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorSourceByteOffset {
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorComposition {
    pub revision: u64,
    pub range: EditorByteRange,
    pub text: String,
}
impl From<editor::Composition> for EditorComposition {
    fn from(value: editor::Composition) -> Self {
        Self {
            revision: value.revision.0,
            range: value.range.into(),
            text: value.text,
        }
    }
}
