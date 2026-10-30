//! Owned inline spelling pieces, marker identities and verified output metadata.
use crate::inline::row::SpanKind;
use std::ops::Range;

pub(in crate::inline) struct Piece {
    pub raw: String,
    pub origin: Option<Range<usize>>,
    pub timing: bool,
    pub display: String,
    pub spans: Vec<usize>,
    pub trailing: bool,
    pub definition: Option<std::sync::Arc<str>>,
}
pub(in crate::inline) struct Marker {
    pub kind: SpanKind,
    pub open: String,
    pub close: String,
}

pub(in crate::inline) struct Spelling {
    pub text: String,
    pub origins: Vec<(Range<usize>, Range<usize>)>,
    pub delimiters: Vec<Range<usize>>,
    pub caret: usize,
    pub input_start: usize,
    pub anchors: Vec<usize>,
    pub parsed: usize,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}
