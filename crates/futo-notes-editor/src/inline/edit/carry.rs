//! Retain active marker identities when carrying formatting across input.
use super::{delimiter, InlineFormat, Marker, Piece, SpanKind};

pub(in crate::inline) fn carry_formats(
    before: &mut [Piece],
    after: &[Piece],
    markers: &mut Vec<Marker>,
    active: &mut Vec<usize>,
    formats: &[InlineFormat],
) {
    active.retain(|id| {
        markers[*id]
            .kind
            .format()
            .is_none_or(|format| formats.contains(&format))
    });
    for &format in formats {
        if !active
            .iter()
            .any(|id| markers[*id].kind == SpanKind::Format(format))
        {
            let previous = before
                .iter()
                .rev()
                .take_while(|piece| {
                    !piece.display.contains(['\r', '\n'])
                        && !(piece.display.is_empty() && !piece.raw.is_empty())
                })
                .find(|piece| !piece.display.chars().all(char::is_whitespace));
            let neighbor =
                previous.or_else(|| after.iter().find(|piece| !piece.display.is_empty()));
            let reusable = neighbor.and_then(|piece| {
                piece
                    .spans
                    .iter()
                    .copied()
                    .find(|id| markers[*id].kind == SpanKind::Format(format))
            });
            let id = if let Some(id) = reusable {
                for piece in before.iter_mut().rev() {
                    if piece.display.contains(['\r', '\n'])
                        || piece.display.is_empty() && !piece.raw.is_empty()
                        || !piece.display.chars().all(char::is_whitespace)
                    {
                        break;
                    }
                    piece.spans.push(id);
                }
                id
            } else {
                let delimiter = delimiter(format);
                let spelling = before.iter().rev().chain(after.iter()).find_map(|piece| {
                    piece
                        .spans
                        .iter()
                        .find(|id| markers[**id].kind == SpanKind::Format(format))
                        .map(|id| (markers[*id].open.clone(), markers[*id].close.clone()))
                });
                let id = markers.len();
                let (open, close) =
                    spelling.unwrap_or_else(|| (delimiter.into(), delimiter.into()));
                markers.push(Marker {
                    pending: false,
                    kind: SpanKind::Format(format),
                    open,
                    close,
                });
                id
            };
            active.push(id);
        }
    }
}
