//! Owned inline spelling pieces, marker identities and verified output metadata.
use crate::inline::row::SpanKind;
use std::ops::Range;

#[derive(Clone)]
pub(in crate::inline) enum PieceOrigin {
    Source(Range<usize>),
    Inserted(Range<usize>),
}

pub(in crate::inline) struct Piece {
    pub raw: String,
    pub origin: Option<PieceOrigin>,
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
    pub origins: Vec<(PieceOrigin, Range<usize>)>,
    pub delimiters: Vec<Range<usize>>,
    pub caret: usize,
    pub input_start: usize,
    pub anchors: Vec<usize>,
    pub parsed: usize,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}
