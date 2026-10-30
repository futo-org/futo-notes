use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision(pub u64);

/// UTF-8 byte coordinates in the display, never a native UTF-16 index.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayOffset(pub usize);

/// UTF-8 byte coordinates in exact source, distinct from display positions.
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

/// Native UTF-16 code-unit coordinates, never UTF-8 byte indices.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayUtf16Offset(pub usize);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUtf16Offset(pub usize);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayUtf16Range {
    pub start: DisplayUtf16Offset,
    pub end: DisplayUtf16Offset,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUtf16Range {
    pub start: SourceUtf16Offset,
    pub end: SourceUtf16Offset,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditWork {
    /// Bytes in materialized source windows, the final candidate and removed
    /// footprints. Excludes per-segment copies and Ropey's internal tree work;
    /// this is not a complete allocation or end-to-end latency measurement.
    pub materialized_source_bytes: usize,
    pub inserted_bytes: usize,
    /// Bytes supplied to the markdown parser, including verification parses.
    pub parsed_source_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewChange {
    pub previous_revision: Revision,
    pub revision: Revision,
    pub range: DisplayRange,
    pub inserted: String,
    pub selection: DisplayRange,
    pub work: EditWork,
    pub affinity: Affinity,
    /// Semantic replacement for the reparsed paragraph window, including
    /// source/display correspondence even when display text did not change.
    pub projection: ProjectionSlice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaretDirection {
    Backward,
    Forward,
}

/// A selection-only update: source and its revision are unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionChange {
    pub revision: Revision,
    pub selection: DisplayRange,
    pub affinity: Affinity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorError {
    StaleRevision {
        expected: Revision,
        actual: Revision,
    },
    InvalidRange,
    InvalidText,
    CompositionActive,
    RevisionExhausted,
    UnrepresentableFormat,
    Persistence(String),
    RecoveryMismatch,
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for EditorError {}

/// Inline meaning supplied by the engine; views never parse marker spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum InlineFormat {
    Bold,
    Italic,
    Strike,
    Code,
}

/// Which visible neighbor supplies formatting at a hidden marker boundary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Affinity {
    Backward,
    #[default]
    Forward,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticRun {
    pub range: DisplayRange,
    pub formats: Vec<InlineFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Correspondence {
    pub source: SourceRange,
    pub display: DisplayRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockDescription {
    pub range: DisplayRange,
    pub heading: u8,
    pub quote_depth: usize,
    pub divider: bool,
    pub code: bool,
    /// First info-string word, preserving its case; rendering never rewrites source.
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionSlice {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
    pub runs: Vec<SemanticRun>,
    pub correspondence: Vec<Correspondence>,
    pub blocks: Vec<BlockDescription>,
}
