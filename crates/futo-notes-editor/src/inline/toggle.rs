//! Selected formatting skips opaque code while retaining inline identities.
use super::row::SpanKind;
use super::{
    edit::delimiter,
    spelling::{Marker, Piece},
};
use crate::InlineFormat;
use std::ops::Range;

pub(super) fn pieces(
    changed: &mut [Piece],
    markers: &mut Vec<Marker>,
    selected: Range<usize>,
    format: InlineFormat,
    opaque: &[Range<usize>],
) {
    let (a, z) = (selected.start, selected.end);
    // Formatting commands modify only the selected visible pieces.
    let mut start = 0;
    let all_active = changed
        .iter()
        .filter(|piece| {
            let end = start + piece.display.len();
            let hit = start < z
                && a < end
                && !opaque
                    .iter()
                    .any(|range| range.start <= start && end <= range.end);
            start = end;
            hit
        })
        .all(|piece| {
            piece
                .spans
                .iter()
                .any(|id| markers[*id].kind == SpanKind::Format(format))
        });
    let id = markers.len();
    let delimiter = delimiter(format);
    markers.push(Marker {
        kind: SpanKind::Format(format),
        open: delimiter.into(),
        close: delimiter.into(),
    });
    let mut start = 0;
    for piece in changed {
        let end = start + piece.display.len();
        if start < z
            && a < end
            && !opaque
                .iter()
                .any(|range| range.start <= start && end <= range.end)
        {
            piece
                .spans
                .retain(|id| markers[*id].kind != SpanKind::Format(format));
            if format == InlineFormat::Code {
                if all_active {
                    piece.raw = piece
                        .display
                        .chars()
                        .map(|ch| {
                            if ch.is_ascii_punctuation() {
                                format!("&#{};", ch as u32)
                            } else {
                                ch.to_string()
                            }
                        })
                        .collect();
                } else if !piece.display.contains(['\r', '\n']) {
                    piece.spans.push(id);
                    piece.raw.clone_from(&piece.display);
                }
            } else if !all_active {
                piece.spans.insert(0, id);
            }
        }
        start = end;
    }
}
