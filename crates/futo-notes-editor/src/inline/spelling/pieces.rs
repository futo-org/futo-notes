//! Owned inline spelling pieces, marker identities and verified output metadata.
use crate::inline::row::SpanKind;
use std::ops::Range;

#[derive(Clone)]
pub(in crate::inline) enum PieceOrigin {
    Source(Range<usize>),
    Inserted(Range<usize>),
}

pub(in crate::inline) struct Piece {
    pub literal_url: Option<usize>,
    pub raw: String,
    pub origin: Option<PieceOrigin>,
    pub timing: bool,
    pub display: String,
    pub spans: Vec<usize>,
    pub trailing: bool,
    pub definition: Option<std::sync::Arc<str>>,
}
pub(in crate::inline) struct Marker {
    pub literal_url: bool,
    pub pending: bool,
    pub activate: bool,
    pub kind: SpanKind,
    pub open: String,
    pub close: String,
}

pub(in crate::inline) struct Spelling {
    pub materialized: usize,
    pub text: String,
    pub origins: Vec<(PieceOrigin, Range<usize>)>,
    pub delimiters: Vec<Range<usize>>,
    pub pending_links: Vec<Range<usize>>,
    pub activated_links: Vec<Range<usize>>,
    pub caret: usize,
    pub input_start: usize,
    pub anchors: Vec<usize>,
    pub parsed: usize,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}

/// One canonical full-tail spelling for an already owned reference link.
/// Parser-normalized keys retain the source escapes used by the existing
/// inline spelling repair; callers never normalize or escape a second time.
pub(in crate::inline) fn full_reference_close(
    target: &crate::inline::row::LinkMeaning,
    open: &str,
    close: &str,
) -> Option<String> {
    target
        .reference
        .as_ref()
        .filter(|_| open == "[" && (close == "]" || close == "][]"))
        .map(|reference| format!("][{reference}]"))
}
