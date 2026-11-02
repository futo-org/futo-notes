//! Emit exact marker stacks and source identities for spelling verification.
use super::{Marker, Piece, Span, SpanKind};
use std::ops::Range;

pub(super) struct Rendered {
    pub(super) text: String,
    pub(super) caret: usize,
    pub(super) winners: Vec<crate::inline::references::Winner>,
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
    let mut winners = Vec::new();
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
        if let Some(key) = &piece.definition {
            winners.push(crate::inline::references::Winner {
                range: start..output.len(),
                key: key.clone(),
            });
        }
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
    let link_metadata_items = winners.len()
        + spans
            .iter()
            .filter(|(_, span)| matches!(span.kind, SpanKind::Link(_)))
            .count();
    Rendered {
        link_metadata_items,
        winners,
        caret: caret.unwrap_or(output.len()),
        text: output,
        spans,
        pieces: piece_ranges,
    }
}

// Every successful replacement discards one real completed source allocation.
// The final buffer moves to Spelling and is counted by its owning plan.
pub(super) fn replace(
    current: &mut Rendered,
    pieces: &[Piece],
    markers: &[Marker],
    insertion: Range<usize>,
) -> usize {
    let discarded = current.text.len();
    *current = render(pieces, markers, insertion.start, insertion.end);
    discarded
}
