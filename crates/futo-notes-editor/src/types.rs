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
    /// Bytes supplied to the markdown parser, including verification parses,
    /// and the table run (plus rows checked) read for input in a table cell.
    pub parsed_source_bytes: usize,
    /// Charged metadata visits and fixed-size copies during link/reference
    /// interpretation, source correspondence, pending-field planning and block
    /// boundary/physical-row selection membership and inline seam comparisons.
    /// Parser input is counted separately above; this is not total CPU work.
    pub link_metadata_items: usize,
    /// Bytes copied into retained link/reference meaning and returned targets;
    /// parser temporary allocations are represented by parser input above.
    pub link_copied_bytes: usize,
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
    ReplayMismatch,
    /// A claim (wikilink completion, async image insertion) no longer matches
    /// the run, note ids or session it was issued for.
    StaleClaim,
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

/// One contiguous link identity, independent of nested formatting or other
/// links with the same destination. The range covers only visible link glyphs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkDescription {
    pub range: DisplayRange,
    pub destination: String,
    pub title: Option<String>,
}

/// How a correspondence piece maps its source onto its display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CorrespondenceKind {
    /// Equal lengths; each display byte is the source byte at the same distance
    /// into the run. Adjacent literal stretches arrive as one run.
    Literal,
    /// Source with no display (markers, hidden syntax); `display` is empty.
    Hidden,
    /// One indivisible source piece shown as other text (a decoded entity, a
    /// divider glyph). Interior offsets map only to its whole source range,
    /// even when the two lengths happen to match.
    Replaced,
}

/// One source/display piece. Pieces arrive in display (and source) order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Correspondence {
    pub source: SourceRange,
    pub display: DisplayRange,
    pub kind: CorrespondenceKind,
}

impl Correspondence {
    /// The source bytes this piece maps to display offset `at`, or `None`
    /// when `at` lies outside it. An edge maps to the matching source edge; a
    /// hidden piece or a replaced interior maps to its whole source range.
    /// Where several pieces meet at one display offset (hidden markers between
    /// visible text, a line start), `EditorSession::source_at` chooses the caret.
    pub fn source_bounds(&self, at: DisplayOffset) -> Option<SourceRange> {
        if at.0 < self.display.start.0 || at.0 > self.display.end.0 {
            return None;
        }
        let point = |offset: usize| SourceRange {
            start: SourceOffset(offset),
            end: SourceOffset(offset),
        };
        Some(if self.kind == CorrespondenceKind::Hidden {
            self.source
        } else if at == self.display.start {
            point(self.source.start.0)
        } else if at == self.display.end {
            point(self.source.end.0)
        } else if self.kind == CorrespondenceKind::Literal {
            point(self.source.start.0 + at.0 - self.display.start.0)
        } else {
            self.source
        })
    }

    /// The display offset for source offset `at`, or `None` outside this piece
    /// or strictly inside a replaced one. A hidden piece maps to its display point.
    pub fn display_at(&self, at: SourceOffset) -> Option<DisplayOffset> {
        if at.0 < self.source.start.0 || at.0 > self.source.end.0 {
            return None;
        }
        match self.kind {
            CorrespondenceKind::Literal => Some(DisplayOffset(
                self.display.start.0 + at.0 - self.source.start.0,
            )),
            CorrespondenceKind::Hidden => Some(self.display.start),
            CorrespondenceKind::Replaced if at == self.source.start => Some(self.display.start),
            CorrespondenceKind::Replaced if at == self.source.end => Some(self.display.end),
            CorrespondenceKind::Replaced => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
/// A list line, or an indented plain line (empty `marker`, not `ordered`).
pub struct ListDescription {
    /// Columns of the line's own leading whitespace (space 1, tab 4).
    pub indent: usize,
    /// The list marker as typed (`-`, `3)`, `10.`); empty on a plain line.
    pub marker: String,
    pub ordered: bool,
    pub checked: Option<bool>,
    pub first: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockDescription {
    pub range: DisplayRange,
    pub heading: u8,
    pub quote_depth: usize,
    pub divider: bool,
    pub list: Option<ListDescription>,
    pub code: bool,
    /// First info-string word, preserving its case; rendering never rewrites source.
    pub language: Option<String>,
    /// Leading front matter, shown verbatim as inert metadata (no Markdown,
    /// no caret, no edits except a selection covering all of it).
    #[serde(default)]
    pub metadata: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionSlice {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
    pub runs: Vec<SemanticRun>,
    pub correspondence: Vec<Correspondence>,
    pub blocks: Vec<BlockDescription>,
    pub links: Vec<LinkDescription>,
    #[serde(default)]
    pub wikilinks: Vec<WikilinkDescription>,
    #[serde(default)]
    pub atoms: Vec<AtomDescription>,
}

/// What an atom is. Renderers draw it as one unit and keep the caret outside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AtomKind {
    Image,
    Divider,
}

/// A non-text atom. `range` covers its visible glyphs (an image keeps its
/// `![alt](destination)` spelling in display text). The only caret stops are
/// `before` and `after`; none lies strictly inside. Deleting an atom is replacing
/// `range` with nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AtomDescription {
    pub kind: AtomKind,
    pub range: DisplayRange,
    pub before: DisplayOffset,
    pub after: DisplayOffset,
    pub image: Option<ImageDescription>,
}

/// An image's saved meaning. `alt` is the source spelling between `![` and `]`;
/// `destination` is the parsed destination (or the destination a reference
/// definition supplies); `reference` is the definition label for reference
/// images. `vault` is the canonical vault-image classification, so a shell
/// resolves a platform URL for display only and never writes it to source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageDescription {
    pub alt: String,
    pub destination: String,
    pub title: Option<String>,
    pub reference: Option<String>,
    pub vault: bool,
}

/// Issued when an asynchronous insertion (picker, paste, capture) begins and
/// presented when it finishes. It names the editor session it was issued for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageClaim(pub u64);

/// A `[[target]]` outside code and HTML. The range covers its visible source
/// glyphs; a renderer may draw `label` in their place. `note_id` is `None` for
/// an absent or ambiguous target, whose label is the raw target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkDescription {
    pub range: DisplayRange,
    pub target: String,
    pub label: String,
    pub note_id: Option<String>,
}

/// One note a `[[` completion offers. `note_id` is the full id the link will
/// name; `label` is its shortest unique suffix; `detail` repeats the id only when
/// the label does not already show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkCandidate {
    pub note_id: String,
    pub label: String,
    pub detail: Option<String>,
}

/// The open `[[` run at the caret. `range` is what acceptance replaces: from the
/// first `[` through the caret, and through an immediately following `]]`.
/// `query` is the source text typed after `[[`. A run nothing matches is still
/// reported, with no candidates, so a consumer can remember a dismissal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkCompletion {
    pub revision: Revision,
    pub range: DisplayRange,
    pub query: String,
    pub candidates: Vec<WikilinkCandidate>,
}

/// Semantic replacements for only the wikilinks whose resolution or label a
/// note-id delivery changed. Source, display text and revision are unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteIdChange {
    pub revision: Revision,
    pub projections: Vec<ProjectionSlice>,
    pub work: NoteIdWork,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteIdWork {
    /// Id suffix entries indexed and ids compared; proportional to the vault.
    pub catalog_items: usize,
    /// Row-tree nodes entered while locating links the change can affect.
    pub rows_visited: usize,
    /// Links re-resolved in those rows, including leaf-hash false positives.
    pub links_examined: usize,
}
