use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision(pub u64);

/// UTF-8 byte coordinates in the display, never a native UTF-16 index.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayOffset(pub usize);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceOffset(pub usize);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayRange {
    pub start: DisplayOffset,
    pub end: DisplayOffset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRange {
    pub start: SourceOffset,
    pub end: SourceOffset,
}

/// A validated source replacement. The host accepts this before the view changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceEdit {
    pub previous_revision: Revision,
    pub revision: Revision,
    pub range: SourceRange,
    pub removed: String,
    pub inserted: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EditWork {
    /// Source bytes materialized by the engine for this edit, excluding Ropey's
    /// internal tree work. This is not an end-to-end latency measurement.
    pub materialized_source_bytes: usize,
    pub inserted_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewChange {
    pub previous_revision: Revision,
    pub revision: Revision,
    pub range: DisplayRange,
    pub inserted: String,
    pub selection: DisplayRange,
    pub work: EditWork,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorError {
    StaleRevision {
        expected: Revision,
        actual: Revision,
    },
    InvalidRange,
    RevisionExhausted,
    Persistence(String),
    RecoveryMismatch,
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for EditorError {}
