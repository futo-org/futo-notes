//! Standard Markdown spelling for a typed closer at an unfinished GFM URL.
//! Only parser-owned delimiter runs receive provenance; loaded escapes never do.
use super::{
    render::{render, Rendered},
    Marker, Piece, Row, SpanKind,
};
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
impl Timing {
    fn render(
        &mut self,
        pieces: &[Piece],
        markers: &[Marker],
        insertion: &Range<usize>,
    ) -> Rendered {
        let rendered = render(pieces, markers, insertion.start, insertion.end);
        self.materialized += rendered.text.len();
        self.work.items +=
            rendered.link_metadata_items + rendered.pieces.len() + rendered.spans.len();
        rendered
    }
    fn parse(&mut self, rendered: &Rendered, references: &Arc<References>) -> Row {
        let parsed = Row::parse_with_references(&rendered.text, references, &rendered.winners);
        self.work.parsed += parsed.parsed_source_bytes;
        self.work.items += parsed.reference_work.items;
        self.work.copied += parsed.reference_work.copied;
        parsed
    }
}

fn bare_ends(row: &Row, work: &mut usize) -> Vec<usize> {
    row.spans
        .iter()
        .filter_map(|span| {
            *work += 1;
            if matches!(span.kind, SpanKind::Link(_))
                && span.open.is_empty()
                && span.close.is_empty()
            {
                *work += 1;
                Some(span.close.start)
            } else {
                None
            }
        })
        .collect()
}
fn ends_at(ends: &[usize], at: usize, work: &mut usize) -> bool {
    ends.binary_search_by(|end| {
        *work += 1;
        end.cmp(&at)
    })
    .is_ok()
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
    if !punctuation {
        if !ending
            || !pieces.iter().any(|piece| {
                timing.work.items += 1;
                piece.timing
            })
        {
            return timing;
        }
    }
    let raw = timing.render(pieces, markers, &insertion);
    if !raw.text.contains(':') && !raw.text.contains("www.") {
        return timing;
    }
    if ending {
        let mut index = 0;
        while index < insertion.start {
            timing.work.items += 1;
            if !pieces[index].timing {
                index += 1;
                continue;
            }
            // A parser-owned multi-character opener must be reconsidered as
            // one run. Individually unescaping its atoms can create a different
            // valid single-character pair before the full pair is available.
            let mut end = index + 1;
            while end < insertion.start {
                timing.work.items += 1;
                if !pieces[end].timing || pieces[end].display != pieces[index].display {
                    break;
                }
                end += 1;
            }
            let saved: Vec<_> = pieces[index..end]
                .iter_mut()
                .map(|piece| {
                    timing.work.items += 1;
                    timing.work.copied += piece.display.len();
                    std::mem::replace(&mut piece.raw, piece.display.clone())
                })
                .collect();
            let candidate = timing.render(pieces, markers, &insertion);
            let parsed = timing.parse(&candidate, references);
            let ends = bare_ends(&parsed, &mut timing.work.items);
            let opener = candidate.pieces[index].start..candidate.pieces[end - 1].end;
            let paired = parsed.spans.iter().any(|span| {
                timing.work.items += 1;
                emphasis(&span.kind)
                    && span.open == opener
                    && span.close.end <= candidate.pieces[insertion.start].start
                    && ends_at(&ends, span.close.start, &mut timing.work.items)
            });
            for (piece, saved) in pieces[index..end].iter_mut().zip(saved) {
                timing.work.items += 1;
                if paired {
                    piece.timing = false;
                } else {
                    piece.raw = saved;
                }
            }
            if paired {
                timing.literal = Some(false);
            }
            index = end;
        }
    } else {
        let parsed = timing.parse(&raw, references);
        let ends = bare_ends(&parsed, &mut timing.work.items);
        let input = raw.pieces[insertion.start].start..raw.pieces[insertion.end - 1].end;
        for span in &parsed.spans {
            timing.work.items += 1;
            if !emphasis(&span.kind)
                || input.end <= span.close.start
                || span.close.end <= input.start
                || !ends_at(&ends, span.close.start, &mut timing.work.items)
            {
                continue;
            }
            // CommonMark can initially pair only part of a run (the second
            // star of ** with a single closing star). Preserve that complete
            // contiguous source opener run until the word actually ends.
            let marker = raw.text.as_bytes()[span.open.start];
            let mut open = span.open.clone();
            while open.start > 0 && raw.text.as_bytes()[open.start - 1] == marker {
                open.start -= 1;
            }
            while open.end < span.close.start && raw.text.as_bytes()[open.end] == marker {
                open.end += 1;
            }
            let first = raw.pieces.partition_point(|range| {
                timing.work.items += 1;
                range.end <= open.start
            });
            for (piece, range) in pieces[first..].iter_mut().zip(&raw.pieces[first..]) {
                timing.work.items += 1;
                if range.start >= open.end {
                    break;
                }
                if open.start <= range.start
                    && range.end <= open.end
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

pub(super) fn collect_delimiters(
    pieces: &[Piece],
    rendered: &Rendered,
    work: &mut usize,
) -> Vec<Range<usize>> {
    pieces
        .iter()
        .zip(&rendered.pieces)
        .filter_map(|(piece, range)| {
            *work += 1;
            if piece.timing {
                *work += 1;
                Some(range.clone())
            } else {
                None
            }
        })
        .collect()
}

impl super::Spelling {
    pub(in crate::inline) fn relocate_delimiters(&mut self, source: usize) -> usize {
        for range in &mut self.delimiters {
            range.start += source;
            range.end += source;
        }
        2 * self.delimiters.len()
    }
}
