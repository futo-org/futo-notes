use super::*;

/// Hosts issue a fresh token for each attachment. The engine retains its mode
/// incarnation across handoffs; generation identifies a frame within that mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedCursor {
    pub token: SessionToken,
    pub incarnation: u64,
    pub revision: Revision,
    pub generation: u64,
}

/// Explicit payload work, not CPU or allocation timing. Ropey's internal tree
/// operations/allocations are excluded, as in EditWork. Entry prepares indexed
/// certificates with note-sized traversal; materialization is deliberately
/// proportional. Only certified input and continuation steps have fixed limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedWork {
    pub inspected_source_bytes: usize,
    pub input_bytes: usize,
    pub parsed_source_bytes: usize,
    pub copied_bytes: usize,
    /// Explicit fixed-size owned metadata records and retained length updates;
    /// not a count of instructions or Ropey internal node visits.
    pub metadata_items: usize,
    pub retired_history_records: usize,
    pub retired_history_payload_bytes: usize,
    pub returned_text_bytes: usize,
    pub returned_records: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundedError {
    Editor(EditorError),
    Unsupported,
    StaleCursor,
}

/// Rejected ownership transfer returns the original usable session.
pub struct BoundedEntryError {
    pub session: Box<EditorSession>,
    pub error: BoundedError,
}
impl std::fmt::Debug for BoundedEntryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

/// An affine map is supplied only by retained opaque-code identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeIdentity {
    pub source: SourceRange,
    pub display: DisplayRange,
}

/// A fragment does not claim to describe a complete physical block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeFragment {
    pub owner: SourceOffset,
    pub range: DisplayRange,
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedCodeProjection {
    pub range: DisplayRange,
    pub text: String,
    pub identity: CodeIdentity,
    pub block: CodeFragment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedChange {
    pub previous: BoundedCursor,
    pub cursor: BoundedCursor,
    pub range: DisplayRange,
    pub inserted: String,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub projection: BoundedCodeProjection,
    pub source_change: BoundedSourceChange,
    pub continuation: Option<ProjectionContinuation>,
    pub work: BoundedWork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionContinuation {
    pub id: u64,
    pub cursor: BoundedCursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedSourceChange {
    pub range: SourceRange,
    pub inserted_bytes: usize,
}

/// Code identity is explicit; a hidden terminal frame has its own mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedProgressChange {
    pub previous: BoundedCursor,
    pub cursor: BoundedCursor,
    pub range: DisplayRange,
    pub inserted: String,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub source_change: Option<BoundedSourceChange>,
    pub source_footprint: SourceRange,
    pub projection: BoundedMeaning,
    pub continuation: Option<ProjectionContinuation>,
    pub work: BoundedWork,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedProgressStatus {
    pub previous: BoundedCursor,
    pub cursor: BoundedCursor,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub continuation: Option<ProjectionContinuation>,
    pub work: BoundedWork,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundedProgress {
    Change(BoundedProgressChange),
    Status(BoundedProgressStatus),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundedMapKind {
    Literal,
    Atom,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedMap {
    pub source: SourceRange,
    pub display: DisplayRange,
    pub kind: BoundedMapKind,
}

/// Explicit semantic fragments; complete physical block descriptions remain
/// available through the unchanged full interface after materialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedBlock {
    pub description: crate::BlockDescription,
    pub source_owner: Option<SourceOffset>,
    pub continues_before: bool,
    pub continues_after: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedMeaning {
    pub range: DisplayRange,
    pub text: String,
    pub mapping: Vec<BoundedMap>,
    pub runs: Vec<crate::SemanticRun>,
    pub blocks: Vec<BoundedBlock>,
    pub links: Vec<crate::LinkDescription>,
}
