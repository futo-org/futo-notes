use futo_notes_editor as editor;
use futo_notes_store as store;

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
    BackspaceJoiningHeading,
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
            EditorParagraphKey::BackspaceJoiningHeading => Self::BackspaceJoiningHeading,
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
    WrapCodeBlock,
    ToggleHeading { level: u8 },
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
            EditorBlockCommand::WrapCodeBlock => Self::WrapCodeBlock,
            EditorBlockCommand::ToggleHeading { level } => Self::ToggleHeading(level),
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
    pub link_metadata_items: u64,
    pub link_copied_bytes: u64,
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
            link_metadata_items: value.work.link_metadata_items as u64,
            link_copied_bytes: value.work.link_copied_bytes as u64,
            affinity: value.affinity.into(),
            projection: value.projection.into(),
        }
    }
}

/// Where the markdown file stands relative to the editor's in-memory text.
#[derive(Debug, uniffi::Record)]
pub struct EditorSaveStatus {
    pub revision: u64,
    /// Last revision written to the markdown file (or the one the note opened at).
    pub saved: u64,
    /// Time until the next save is due; `None` when nothing is unsaved.
    pub save_deadline: Option<std::time::Duration>,
}

impl From<store::SaveStatus> for EditorSaveStatus {
    fn from(value: store::SaveStatus) -> Self {
        Self {
            revision: value.revision.0,
            saved: value.saved.0,
            save_deadline: value.save_deadline,
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
    #[error("replayed edit does not match the worker source")]
    ReplayMismatch,
    #[error("wikilink completion is stale")]
    StaleClaim,
    #[error("editor open failed: {error}")]
    Open { error: String },
    #[error("editor session already open")]
    SessionAlreadyOpen,
    #[error("editor checkpoint failed: {error}")]
    Checkpoint { error: String },
    #[error("editor attachment was deleted")]
    SessionDeleted,
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
            E::ReplayMismatch => Self::ReplayMismatch,
            E::StaleClaim => Self::StaleClaim,
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
            E::Checkpoint(error) => Self::Checkpoint { error },
            E::SessionDeleted => Self::SessionDeleted,
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
pub struct EditorLinkDescription {
    pub range: EditorByteRange,
    pub destination: String,
    pub title: Option<String>,
}
impl From<editor::LinkDescription> for EditorLinkDescription {
    fn from(value: editor::LinkDescription) -> Self {
        Self {
            range: value.range.into(),
            destination: value.destination,
            title: value.title,
        }
    }
}
/// A wikilink's visible glyphs and the label/resolution the engine derived
/// from store-delivered note ids. `note_id` is absent when unresolved.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorWikilinkDescription {
    pub range: EditorByteRange,
    pub target: String,
    pub label: String,
    pub note_id: Option<String>,
}
impl From<editor::WikilinkDescription> for EditorWikilinkDescription {
    fn from(value: editor::WikilinkDescription) -> Self {
        Self {
            range: value.range.into(),
            target: value.target,
            label: value.label,
            note_id: value.note_id,
        }
    }
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorSourceByteRange {
    pub start: u64,
    pub end: u64,
}
/// A long note's first screens before its session exists, exactly as that
/// session will show them: `projection.text` is the display text, and
/// `tables` the tables starting in it. Read-only; nothing is attached.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorQuickOpen {
    pub projection: EditorProjection,
    pub tables: Vec<super::tables::EditorTableDescription>,
}
impl From<editor::QuickOpen> for EditorQuickOpen {
    fn from(value: editor::QuickOpen) -> Self {
        Self {
            projection: value.projection.into(),
            tables: value.tables.into_iter().map(Into::into).collect(),
        }
    }
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorProjection {
    pub revision: u64,
    pub range: EditorByteRange,
    pub text: String,
    pub runs: Vec<EditorSemanticRun>,
    pub correspondence: Vec<super::correspondence::EditorCorrespondence>,
    pub blocks: Vec<EditorBlockDescription>,
    pub links: Vec<EditorLinkDescription>,
    pub wikilinks: Vec<EditorWikilinkDescription>,
    pub atoms: Vec<super::images::EditorAtomDescription>,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorListDescription {
    pub indent: u64,
    pub level: u64,
    pub marker: String,
    pub ordered: bool,
    pub checked: Option<bool>,
    pub first: bool,
}
impl From<editor::ListDescription> for EditorListDescription {
    fn from(value: editor::ListDescription) -> Self {
        Self {
            indent: value.indent as u64,
            level: value.level as u64,
            marker: value.marker,
            ordered: value.ordered,
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
    /// Leading front matter, shown verbatim; hosts may render it as a panel.
    pub metadata: bool,
}
impl From<editor::ProjectionSlice> for EditorProjection {
    fn from(value: editor::ProjectionSlice) -> Self {
        Self {
            revision: value.revision.0,
            range: value.range.into(),
            text: value.text,
            links: value.links.into_iter().map(Into::into).collect(),
            wikilinks: value.wikilinks.into_iter().map(Into::into).collect(),
            atoms: value.atoms.into_iter().map(Into::into).collect(),
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
                    metadata: block.metadata,
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
            correspondence: value.correspondence.into_iter().map(Into::into).collect(),
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
    /// How to draw the marked text: the formats it will have once committed.
    pub runs: Vec<EditorMarkedRun>,
}
/// A formatted stretch of marked text, in UTF-16 units of `EditorComposition::text`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorMarkedRun {
    pub start_utf16: u64,
    pub end_utf16: u64,
    pub formats: Vec<EditorInlineFormat>,
}
impl From<editor::Composition> for EditorComposition {
    fn from(value: editor::Composition) -> Self {
        let utf16 = |byte: usize| value.text[..byte].encode_utf16().count() as u64;
        let runs = value
            .runs
            .iter()
            .map(|run| EditorMarkedRun {
                start_utf16: utf16(run.start),
                end_utf16: utf16(run.end),
                formats: run.formats.iter().copied().map(Into::into).collect(),
            })
            .collect();
        Self {
            revision: value.revision.0,
            range: value.range.into(),
            text: value.text,
            runs,
        }
    }
}
