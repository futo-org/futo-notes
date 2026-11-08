//! Nest bold and italic so one `***` run reads back as the spans written.
use super::{Marker, Piece, SpanKind};
use crate::InlineFormat;

/// `***` closes as italic around bold, so bold directly around italic cannot
/// share a delimiter run. Put italic outside bold wherever a bold span sits directly around an italic
/// one and both lost their spans. Reports whether any nesting changed.
pub(super) fn swap_emphasis_nesting(
    pieces: &mut [Piece],
    markers: &[Marker],
    missing: &[usize],
) -> bool {
    let mut swapped = false;
    for piece in pieces {
        for at in 1..piece.spans.len() {
            let (outer, inner) = (piece.spans[at - 1], piece.spans[at]);
            if missing.contains(&outer)
                && missing.contains(&inner)
                && markers[outer].kind == SpanKind::Format(InlineFormat::Bold)
                && markers[inner].kind == SpanKind::Format(InlineFormat::Italic)
            {
                piece.spans.swap(at - 1, at);
                swapped = true;
            }
        }
    }
    swapped
}
