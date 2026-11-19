//! Images: claimed insertion (`insert`), and what a line shows around an
//! image. The keys that treat an image as one unit are the atoms'
//! (`atoms.rs`).
//!
//! An image shows its whole source spelling (`![alt](reference)`) and a view
//! draws its atom as one object.
mod insert;

use crate::lines::Span;
use std::ops::Range;

/// Whether a mark other than the image at `image` holds it (a link around
/// it, bold around it): taking the image out alone would leave that mark
/// empty, and a line break inside it would split it.
pub(super) fn inside_another_mark(spans: &[Span], image: &Range<usize>) -> bool {
    spans.iter().any(|span| {
        span.range != *image && span.range.start <= image.start && image.end <= span.range.end
    })
}

/// Whether line `text` (read as `spans`, `content` its content range) shows
/// anything besides `image` before it and after it: only what a reader sees
/// counts, so markers, whitespace and hidden syntax (the `[](u)` of a link
/// with no text) do not.
pub(super) fn shows_around(
    text: &str,
    spans: &[Span],
    content: &Range<usize>,
    image: &Range<usize>,
) -> (bool, bool) {
    let hidden = |at: usize| {
        spans
            .iter()
            .any(|span| span.open.contains(&at) || span.close.contains(&at))
    };
    let shows = |range: Range<usize>| {
        text.get(range.clone()).is_some_and(|piece| {
            piece
                .char_indices()
                .any(|(at, ch)| !ch.is_whitespace() && !hidden(range.start + at))
        })
    };
    (
        shows(content.start..image.start),
        shows(image.end..content.end),
    )
}
