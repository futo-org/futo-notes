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
) -> usize {
    let mut work = 0;
    let (a, z) = (selected.start, selected.end);
    // Formatting commands modify only the selected visible pieces.
    let mut start = 0;
    let mut active_work = 0;
    let all_active = changed
        .iter()
        .filter(|piece| {
            work += 1;
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
            piece.spans.iter().any(|id| {
                active_work += 1;
                markers[*id].kind == SpanKind::Format(format)
            })
        });
    work += active_work;
    // Only adding Code over a complete owned automatic link may retire that
    // source stack. Active/authored links and partially covered pending bodies
    // retain their existing identities until their separate intent is proved.
    let complete_pending = if format == InlineFormat::Code
        && !all_active
        && markers.iter().any(|marker| {
            work += 1;
            marker.pending
        }) {
        work += 1; // One ephemeral coverage allocation, no retained graph.
        let mut complete: Vec<_> = markers
            .iter()
            .map(|marker| {
                work += 2; // Visit and initialize one coverage slot.
                marker.pending && matches!(marker.kind, SpanKind::Link(_))
            })
            .collect();
        let mut start = 0;
        for piece in changed.iter() {
            work += 1;
            let end = start + piece.display.len();
            if start < a || end > z {
                for id in &piece.spans {
                    work += 2;
                    complete[*id] = false;
                }
            }
            start = end;
        }
        Some(complete)
    } else {
        None
    };
    let id = markers.len();
    let delimiter = delimiter(format);
    markers.push(Marker {
        pending: false,
        activate: false,
        kind: SpanKind::Format(format),
        open: delimiter.into(),
        close: delimiter.into(),
    });
    let mut start = 0;
    for piece in changed {
        work += 1;
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
                    if let Some(complete) = &complete_pending {
                        piece.spans.retain(|id| {
                            work += 1;
                            !complete[*id]
                        });
                    }
                    piece.spans.push(id);
                    piece.raw.clone_from(&piece.display);
                }
            } else if !all_active {
                piece.spans.insert(0, id);
            }
        }
        start = end;
    }
    work
}
