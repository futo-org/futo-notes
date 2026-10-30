//! Standard Markdown spelling for a typed closer at an unfinished GFM URL.
//! Only parser-owned delimiters receive provenance; loaded escapes never do.
use super::{render::render, Marker, Piece, Row, SpanKind};
use crate::{
    inline::references::{ReferenceWork, References},
    InlineFormat,
};
use std::{ops::Range, sync::Arc};

#[derive(Default)]
pub(in crate::inline) struct Timing {
    pub literal: Option<bool>,
    pub work: ReferenceWork,
    pub materialized: usize,
}

pub(in crate::inline) fn prepare_url_input(
    pieces: &mut [Piece],
    markers: &[Marker],
    insertion: Range<usize>,
    inserted: &str,
    references: &Arc<References>,
) -> Timing {
    let mut timing = Timing::default();
    if insertion.is_empty() {
        return timing;
    }
    let ending = inserted.chars().next().is_some_and(char::is_whitespace);
    let punctuation = inserted.chars().any(|ch| matches!(ch, '*' | '_' | '~'));
    if !punctuation && !(ending && pieces.iter().any(|piece| piece.timing)) {
        return timing;
    }
    let raw = render(pieces, markers, insertion.start, insertion.end);
    timing.materialized += raw.text.len();
    timing.work.items += raw.link_metadata_items + pieces.len();
    if !raw.text.contains(':') && !raw.text.contains("www.") {
        return timing;
    }
    if ending {
        // Test only witnessed escapes. An arbitrary authored escape that happens
        // to precede a URL is never eligible for automatic removal.
        for index in 0..insertion.start {
            timing.work.items += 1;
            if !pieces[index].timing {
                continue;
            }
            let saved = pieces[index].raw.clone();
            timing.work.copied += saved.len();
            timing.work.copied += pieces[index].display.len();
            pieces[index].raw = pieces[index].display.clone();
            let candidate = render(pieces, markers, insertion.start, insertion.end);
            timing.materialized += candidate.text.len();
            timing.work.items += candidate.link_metadata_items;
            let parsed =
                Row::parse_with_references(&candidate.text, references, &candidate.winners);
            timing.work.parsed += parsed.parsed_source_bytes;
            timing.work.items += parsed.reference_work.items + parsed.spans.len();
            timing.work.copied += parsed.reference_work.copied;
            let opener = &candidate.pieces[index];
            let paired = parsed.spans.iter().any(|span| {
                emphasis(&span.kind)
                    && span.open.start == opener.start
                    && span.open.end >= opener.end
                    && span.close.end <= candidate.pieces[insertion.start].start
                    && parsed.spans.iter().any(|link| {
                        matches!(link.kind, SpanKind::Link(_))
                            && link.open.is_empty()
                            && link.close.is_empty()
                            && link.close.start == span.close.start
                    })
            });
            if paired {
                pieces[index].timing = false;
                timing.literal = Some(false);
            } else {
                pieces[index].raw = saved;
            }
        }
    } else {
        let parsed = Row::parse_with_references(&raw.text, references, &raw.winners);
        timing.work.parsed += parsed.parsed_source_bytes;
        timing.work.items += parsed.reference_work.items + parsed.spans.len();
        timing.work.copied += parsed.reference_work.copied;
        for span in parsed.spans.iter().filter(|span| emphasis(&span.kind)) {
            if !raw.pieces[insertion.clone()]
                .iter()
                .any(|range| range.start < span.close.end && span.close.start < range.end)
                || !parsed.spans.iter().any(|link| {
                    matches!(link.kind, SpanKind::Link(_))
                        && link.open.is_empty()
                        && link.close.is_empty()
                        && link.close.start == span.close.start
                })
            {
                continue;
            }
            for (piece, range) in pieces.iter_mut().zip(&raw.pieces) {
                timing.work.items += 1;
                if span.open.start <= range.start
                    && range.end <= span.open.end
                    && piece.raw == piece.display
                    && !piece.display.is_empty()
                {
                    piece.raw.insert(0, '\\');
                    piece.timing = true;
                    timing.literal = Some(true);
                }
            }
        }
    }
    timing
}

fn emphasis(kind: &SpanKind) -> bool {
    matches!(
        kind,
        SpanKind::Format(InlineFormat::Bold | InlineFormat::Italic | InlineFormat::Strike)
    )
}
