//! What one planned input changes: the source range, its replacement and the
//! bookkeeping the session needs to apply and remember it, with the helpers
//! that find that range and charge refused attempts' work to it.
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

/// `plan` charged with the work of the refused attempts before it.
pub(super) fn spent(mut plan: Plan, tried: Vec<Plan>) -> Plan {
    for attempt in tried {
        plan.materialized += attempt.materialized;
        plan.parsed += attempt.parsed;
        plan.link_metadata_items += attempt.link_metadata_items;
        plan.link_copied_bytes += attempt.link_copied_bytes;
    }
    plan
}

pub(in crate::inline) fn common_prefix(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum()
}
