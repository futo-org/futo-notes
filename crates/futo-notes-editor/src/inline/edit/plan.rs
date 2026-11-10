//! What one planned input changes: the source range, its replacement and the
//! bookkeeping the session needs to apply and remember it.
use super::SourceCorrespondence;
use crate::InlineFormat;
use std::ops::Range;

pub(crate) struct Plan {
    pub guarded_words: Option<crate::inline::guarded_words::GuardUpdate>,
    pub split_retirement: Option<std::sync::Arc<crate::inline::guarded_words::CodeWordIdentity>>,
    pub retained: SourceCorrespondence,
    pub requires_source_identity: bool,
    /// The source window the planner read; `range` lies inside it.
    pub context: Range<usize>,
    pub range: Range<usize>,
    pub delimiters: Vec<Range<usize>>,
    pub pending_links: Vec<Range<usize>>,
    pub activated_links: Vec<Range<usize>>,
    pub inserted: String,
    pub caret: usize,
    pub input_start: usize,
    pub formats: Vec<InlineFormat>,
    pub materialized: usize,
    pub parsed: usize,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}
