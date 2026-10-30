//! Emit exact marker stacks and source identities for spelling verification.
use super::{Marker, Piece, Span, SpanKind};
use std::ops::Range;

pub(super) struct Rendered {
    pub(super) text: String,
    pub(super) caret: usize,
    pub(super) spans: Vec<(usize, Span)>,
    pub(super) pieces: Vec<Range<usize>>,
    pub(super) link_metadata_items: usize,
}
pub(super) fn render(
    pieces: &[Piece],
    markers: &[Marker],
    insertion_index: usize,
    insertion_end: usize,
) -> Rendered {
    let mut output = String::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut openings: Vec<Range<usize>> = Vec::new();
    let mut spans = Vec::new();
    let mut caret = None;
    let mut piece_ranges = Vec::with_capacity(pieces.len());
    for (index, piece) in pieces.iter().enumerate() {
        let common = stack
            .iter()
            .zip(&piece.spans)
            .take_while(|(a, b)| a == b)
            .count();
        while stack.len() > common {
            let id = stack.pop().unwrap();
            let open = openings.pop().unwrap();
            let start = output.len();
            output.push_str(&markers[id].close);
            spans.push((
                id,
                Span {
                    kind: markers[id].kind.clone(),
                    open,
                    close: start..output.len(),
                },
            ));
        }
        if index == insertion_index && insertion_index == insertion_end {
            caret = Some(output.len());
        }
        for &id in &piece.spans[common..] {
            let start = output.len();
            output.push_str(&markers[id].open);
            openings.push(start..output.len());
            stack.push(id);
        }
        let start = output.len();
        output.push_str(&piece.raw);
        piece_ranges.push(start..output.len());
        if index + 1 == insertion_end {
            caret = Some(output.len());
        }
    }
    if insertion_index == pieces.len() && insertion_index == insertion_end {
        caret = Some(output.len());
    }
    while let Some(id) = stack.pop() {
        let open = openings.pop().unwrap();
        let start = output.len();
        output.push_str(&markers[id].close);
        spans.push((
            id,
            Span {
                kind: markers[id].kind.clone(),
                open,
                close: start..output.len(),
            },
        ));
    }
    let link_metadata_items = spans
        .iter()
        .filter(|(_, span)| matches!(span.kind, SpanKind::Link(_)))
        .count();
    Rendered {
        link_metadata_items,
        caret: caret.unwrap_or(output.len()),
        text: output,
        spans,
        pieces: piece_ranges,
    }
}
