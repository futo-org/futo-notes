//! Source/display correspondence runs, projected unchanged from the engine.
use super::*;
use futo_notes_editor as editor;

/// How a piece maps source onto display; see `editor::CorrespondenceKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorCorrespondenceKind {
    /// Equal lengths, byte for byte; adjacent literal stretches are one run.
    Literal,
    /// Source with an empty display range (markers, hidden syntax).
    Hidden,
    /// One indivisible source piece shown as other text (an entity, a divider).
    Replaced,
}

/// One run, in display and source order; the runs tile both coordinate spaces.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCorrespondence {
    pub source: EditorSourceByteRange,
    pub display: EditorByteRange,
    pub kind: EditorCorrespondenceKind,
}

impl From<editor::Correspondence> for EditorCorrespondence {
    fn from(value: editor::Correspondence) -> Self {
        Self {
            source: EditorSourceByteRange {
                start: value.source.start.0 as u64,
                end: value.source.end.0 as u64,
            },
            display: value.display.into(),
            kind: match value.kind {
                editor::CorrespondenceKind::Literal => EditorCorrespondenceKind::Literal,
                editor::CorrespondenceKind::Hidden => EditorCorrespondenceKind::Hidden,
                editor::CorrespondenceKind::Replaced => EditorCorrespondenceKind::Replaced,
            },
        }
    }
}
