//! Nest a selected link without splitting emphasis that still owns neighboring text.
use crate::inline::{
    row::SpanKind,
    spelling::{Marker, Piece},
};
use std::ops::Range;

pub(super) fn replace_selected_links(
    pieces: &mut [Piece],
    markers: &[Marker],
    range: Range<usize>,
    link: Option<usize>,
) -> usize {
    let a = range.start;
    let z = range.end;
    let mut link_metadata_items = 0;
    let mut at = 0;
    let mut outside = vec![false; markers.len()];
    for piece in pieces.iter_mut() {
        let end = at + piece.display.len();
        link_metadata_items += 1;
        if at < z && a < end {
            piece
                .spans
                .retain(|id| !matches!(markers[*id].kind, SpanKind::Link(_)));
        } else if at < end {
            for id in &piece.spans {
                link_metadata_items += 1;
                outside[*id] = true;
            }
        }
        at = end;
    }
    // A link inside part of an emphasis span must stay inside its
    // enclosing markers: splitting them can strand an opening marker
    // before a space. Whole selected spans keep the existing wrapper
    // order; code remains opaque to link syntax.
    let mut at = 0;
    for piece in pieces.iter_mut() {
        let end = at + piece.display.len();
        link_metadata_items += 1;
        if let Some(id) = link.filter(|_| at < z && a < end) {
            let depth = piece
                .spans
                .iter()
                .take_while(|id| {
                    link_metadata_items += 1;
                    outside[**id]
                        && matches!(markers[**id].kind,
                    SpanKind::Format(format) if format != crate::InlineFormat::Code)
                })
                .count();
            piece.spans.insert(depth, id);
        }
        at = end;
    }
    link_metadata_items
}
