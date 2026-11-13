//! Which span marks a replacement keeps, drops or joins.
use super::super::{read, Engine};
use crate::lines::SpanKind;
use std::ops::Range;

/// Syntax a selection keeps: one end of a span reaching out of it.
pub(super) struct Kept {
    pub(super) range: Range<usize>,
    /// Whether this is the span's opening mark (its closing mark is after the
    /// selection) rather than its closing mark.
    pub(super) opens: bool,
    pub(super) kind: std::mem::Discriminant<SpanKind>,
}

impl Engine {
    /// The syntax of spans a selection touches. `seen` holds every source
    /// offset that shows inside the selection, `removed` the source the
    /// selection takes, and `typing` says whether text lands at its start.
    /// A span whose whole text goes, with no text landing in it, loses its
    /// syntax (the second list); a span reaching out of the selection keeps
    /// the syntax inside it (the first list). Both are in source order.
    pub(super) fn span_syntax(
        &self,
        seen: Range<usize>,
        removed: Range<usize>,
        typing: bool,
    ) -> (Vec<Kept>, Vec<Range<usize>>) {
        let mut kept: Vec<Kept> = Vec::new();
        let mut gone: Vec<Range<usize>> = Vec::new();
        let (first, _) = read::line_at(&self.store, seen.start);
        let mut base = self.store.before(first).source;
        for entry in self.store.iter_from(first) {
            if base > seen.end {
                break;
            }
            for span in &entry.spans {
                if span.kind == SpanKind::Escape || span.open.is_empty() || span.close.is_empty() {
                    continue;
                }
                let open = base + span.open.start..base + span.open.end;
                let close = base + span.close.start..base + span.close.end;
                let content = open.end..close.start;
                let inside =
                    |piece: &Range<usize>| removed.start <= piece.start && piece.end <= removed.end;
                let emptied = content.start >= seen.start && content.end <= seen.end;
                let alive =
                    typing && content.start <= removed.start && removed.start <= content.end;
                if emptied && !alive {
                    gone.push(open);
                    gone.push(close);
                } else if inside(&open) != inside(&close) {
                    let opens = inside(&open);
                    kept.push(Kept {
                        range: if opens { open } else { close },
                        opens,
                        kind: std::mem::discriminant(&span.kind),
                    });
                }
            }
            base += entry.text.len();
        }
        kept.sort_by_key(|piece| piece.range.start);
        (kept, gone)
    }

    /// The marks a deletion of `from..to` makes touch: spans closing right
    /// at `from` and spans opening right at `to`, paired from the seam
    /// outwards while they match in kind and spelling. They join, so their
    /// marks go (deleting the line break of `**ab**\n**cd**` leaves
    /// `**abcd**`, not `**ab****cd**`, which shows its asterisks).
    pub(super) fn seam_joins(&self, from: usize, to: usize) -> Vec<Range<usize>> {
        let marks = |at: usize, closing: bool| {
            let mut found: Vec<(Range<usize>, std::mem::Discriminant<SpanKind>)> = Vec::new();
            if closing && at == 0 {
                return found;
            }
            let (index, before) = read::line_at(&self.store, at - usize::from(closing));
            let entry = self.store.get(index);
            let mut seam = at;
            loop {
                let next = entry.spans.iter().find_map(|span| {
                    if span.kind == SpanKind::Escape
                        || span.open.is_empty()
                        || span.close.is_empty()
                    {
                        return None;
                    }
                    let mark = if closing { &span.close } else { &span.open };
                    let mark = before.source + mark.start..before.source + mark.end;
                    let touches = if closing {
                        mark.end == seam
                    } else {
                        mark.start == seam
                    };
                    touches.then(|| (mark, std::mem::discriminant(&span.kind)))
                });
                let Some((mark, kind)) = next else {
                    return found;
                };
                seam = if closing { mark.start } else { mark.end };
                found.push((mark, kind));
            }
        };
        let mut joins = Vec::new();
        for (close, open) in marks(from, true).into_iter().zip(marks(to, false)) {
            if close.1 != open.1
                || self.source_slice(close.0.clone()) != self.source_slice(open.0.clone())
            {
                break;
            }
            joins.push(close.0);
            joins.push(open.0);
        }
        joins
    }
}
