//! Owned inline spelling pieces, marker identities and verified output metadata.
use crate::inline::row::SpanKind;
use std::ops::Range;

#[derive(Clone)]
pub(in crate::inline) enum PieceOrigin {
    Source(Range<usize>),
    Inserted(Range<usize>),
}

pub(in crate::inline) struct Piece {
    pub guard: Option<crate::inline::guarded_words::GuardPart>,
    /// Complete hidden source segment inside a canonical physical line prefix.
    /// A word boundary only: the original raw bytes and origin remain intact.
    pub physical_prefix: bool,
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
    pub source: Option<(Range<usize>, Range<usize>)>,
    pub literal_url: bool,
    pub pending: bool,
    pub activate: bool,
    pub kind: SpanKind,
    pub open: String,
    pub close: String,
}

pub(in crate::inline) struct Spelling {
    /// Whether the input was spelled as literal text, either as asked or
    /// as the fallback for a delimiter the parser would not read as typed.
    pub literal: bool,
    pub split_retirement: Option<std::sync::Arc<crate::inline::guarded_words::CodeWordIdentity>>,
    pub typed_inputs: Option<Vec<crate::inline::typed_angle::TypedAngleOrigin>>,
    pub guarded_words: Option<Vec<crate::inline::guarded_words::GuardedWord>>,
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
