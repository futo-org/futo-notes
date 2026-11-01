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
        let parsed = Row::candidate(&rendered.text, references, &rendered.winners);
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
    action: crate::InputAction,
    references: &Arc<References>,
) -> Timing {
    let mut timing = Timing::default();
    if insertion.is_empty() {
        return timing;
    }
    let ordered = action != crate::InputAction::Isolated;
    // Composition and typing own an ordered text input. Keep the distinct
    // existing isolated/OS/paste policy until its own input owner changes it.
    let ending = if ordered {
        inserted.contains(char::is_whitespace)
    } else {
        inserted.chars().next().is_some_and(char::is_whitespace)
    };
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
    let mut raw = timing.render(pieces, markers, &insertion);
    let mut changed = false;
    if !raw.text.contains(':')
        && !raw.text.as_bytes().windows(4).any(|prefix| {
            timing.work.items += 1;
            prefix.eq_ignore_ascii_case(b"www.")
        })
    {
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
            let separator = if ordered {
                last_separator(pieces, &candidate, &insertion, &mut timing.work.items)
            } else {
                Some(candidate.pieces[insertion.start].start)
            };
            let paired = parsed.spans.iter().any(|span| {
                timing.work.items += 1;
                emphasis(&span.kind)
                    && span.open == opener
                    && separator.is_some_and(|separator| span.close.end <= separator)
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
                changed = true;
            }
            index = end;
        }
    }
    if punctuation && (ordered || !ending) {
        if changed {
            raw = timing.render(pieces, markers, &insertion);
        }
        let parsed = timing.parse(&raw, references);
        let ends = bare_ends(&parsed, &mut timing.work.items);
        let input = raw.pieces[insertion.start].start..raw.pieces[insertion.end - 1].end;
        let separator = if ordered {
            last_separator(pieces, &raw, &insertion, &mut timing.work.items)
        } else {
            None
        };
        for span in &parsed.spans {
            timing.work.items += 1;
            if !emphasis(&span.kind)
                || input.end <= span.close.start
                || span.close.end <= input.start
                || !ends_at(&ends, span.close.start, &mut timing.work.items)
            {
                continue;
            }
            if separator.is_some_and(|separator| span.close.end <= separator) {
                timing.literal = Some(false);
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
fn last_separator(
    pieces: &[Piece],
    rendered: &Rendered,
    insertion: &Range<usize>,
    work: &mut usize,
) -> Option<usize> {
    let mut separator = None;
    for (piece, range) in pieces[insertion.clone()]
        .iter()
        .zip(&rendered.pieces[insertion.clone()])
    {
        *work += 1;
        if piece.display.chars().any(|ch| {
            *work += 1;
            ch.is_whitespace()
        }) {
            separator = Some(range.start);
        }
    }
    separator
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
        for range in self
            .delimiters
            .iter_mut()
            .chain(&mut self.pending_links)
            .chain(&mut self.activated_links)
        {
            range.start += source;
            range.end += source;
        }
        let mut guards = 0;
        if let Some(words) = &mut self.guarded_words {
            for word in words {
                guards += word.relocate(source);
            }
        }
        if let Some(origins) = &mut self.typed_inputs {
            for origin in origins {
                guards += origin.relocate(source);
            }
        }
        guards + 2 * (self.delimiters.len() + self.pending_links.len() + self.activated_links.len())
    }
}

pub(super) fn collect_origins(
    pieces: &[Piece],
    rendered: &Rendered,
    work: &mut usize,
) -> Vec<(super::PieceOrigin, Range<usize>)> {
    pieces
        .iter()
        .zip(&rendered.pieces)
        .filter_map(|(piece, output)| {
            *work += 1;
            piece.origin.as_ref().map(|origin| {
                *work += 3;
                (origin.clone(), output.clone())
            })
        })
        .collect()
}

/// Output identities come only from the same verifier-proven marker instance.
/// Activation is command retirement, never correspondence or timing enrollment.
pub(super) fn collect_link_timing(
    markers: &[Marker],
    rendered: &Rendered,
    work: &mut usize,
) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let (mut pending, mut activated) = (Vec::new(), Vec::new());
    for (id, span) in &rendered.spans {
        *work += 1;
        let marker = &markers[*id];
        debug_assert!(!(marker.pending && marker.activate));
        if marker.pending {
            *work += 2;
            pending.push(span.open.end..span.close.start);
        } else if marker.activate {
            *work += 2;
            activated.push(span.open.end..span.close.start);
        }
    }
    (pending, activated)
}
