//! Planning a replacement: which source bytes typing over a display
//! range writes, and where the caret lands.
use super::super::line::Role;
use super::super::{read, store, Engine};
use crate::lines::SpanKind;
use crate::{Affinity, DisplayRange};
use std::ops::Range;

/// A planned text edit and where the caret ends up after it.
pub(crate) struct Plan {
    pub range: Range<usize>,
    pub inserted: String,
    /// Source offset of the caret after the edit.
    pub caret: usize,
}

/// Syntax a selection keeps: one end of a span reaching out of it.
struct Kept {
    range: Range<usize>,
    /// Whether this is the span's opening mark (its closing mark is after the
    /// selection) rather than its closing mark.
    opens: bool,
    kind: std::mem::Discriminant<SpanKind>,
}

impl Engine {
    // ---- Planning ----

    /// The line ending typing on an empty line with no text behind it
    /// writes: the line's own, else the one above it, else LF.
    pub(crate) fn empty_line_ending(&self, index: usize) -> String {
        let own = self.store.get(index).ending();
        if !own.is_empty() {
            return own.to_owned();
        }
        if index > 0 {
            let above = self.store.get(index - 1).ending();
            if !above.is_empty() {
                return above.to_owned();
            }
        }
        "\n".to_owned()
    }

    /// Whether display offset `at` is on a line that shows with no text
    /// behind it, and that line's index.
    pub(crate) fn empty_line(&self, at: usize) -> Option<usize> {
        let (index, before) = self.line_at_display(store::display, at);
        (self.store.get(index).view.role == Role::Empty && at == before.display).then_some(index)
    }

    /// Replace display `range` with `text`. A collapsed caret inserts exactly
    /// `text` where it maps. A selection removes the visible text in it and
    /// the line markers and hidden lines inside it, keeps the syntax of spans
    /// that reach out of it, and drops the syntax of spans left empty; the
    /// text lands where the selection starts, inside spans that start there.
    pub(crate) fn plan(&self, range: DisplayRange, text: &str) -> Plan {
        let (s, e) = (range.start.0, range.end.0);
        let mut inserted = String::new();
        if s != e || !text.is_empty() {
            if let Some(index) = self.empty_line(s) {
                inserted.push_str(&self.empty_line_ending(index));
            }
        }
        inserted.push_str(text);
        if s == e {
            let at = if range == self.selection {
                self.caret_source()
            } else {
                let (lo, hi) = self.source_bounds(s);
                if self.affinity == Affinity::Backward {
                    lo
                } else {
                    hi
                }
            };
            return Plan {
                range: at..at,
                caret: at + inserted.len(),
                inserted,
            };
        }
        let (lo_s, _) = self.source_span(s);
        let (_, hi_e) = self.source_span(e);
        let metadata_start = self.metadata_end().is_some() && s == 0;
        let from = if metadata_start {
            0
        } else {
            self.source_bounds(s).1
        };
        let lo_s = if metadata_start { 0 } else { lo_s };
        let to = self.source_bounds(e).0;

        let (kept, removed) = self.span_syntax(lo_s..hi_e, from..to, !text.is_empty());
        let start = removed.iter().map(|r| r.start).fold(from, usize::min);
        let end = removed.iter().map(|r| r.end).fold(to, usize::max);
        let old = self.source_slice(start..end);
        let keep_outside = |zone: Range<usize>| {
            let mut out = String::new();
            let mut at = zone.start;
            let mut cuts: Vec<&Range<usize>> = removed
                .iter()
                .filter(|r| r.start < zone.end && r.end > zone.start)
                .collect();
            cuts.sort_by_key(|r| r.start);
            for cut in cuts {
                out.push_str(&old[at - start..cut.start.max(at) - start]);
                at = at.max(cut.end);
            }
            out.push_str(&old[at - start..zone.end - start]);
            out
        };
        let mut replacement = keep_outside(start..from);
        let caret = start + replacement.len() + inserted.len();
        replacement.push_str(&inserted);
        // Syntax kept inside the selection follows the text. A span closing
        // right where one of the same kind and spelling opens joins it: both
        // marks go (deleting `b c` from `**ab** **cd**` leaves `**ad**`).
        let spelled = |piece: &Kept| &old[piece.range.start - start..piece.range.end - start];
        let mut joined: Vec<&Kept> = Vec::new();
        for piece in &kept {
            let joins = joined.last().is_some_and(|last| {
                piece.opens
                    && !last.opens
                    && last.kind == piece.kind
                    && spelled(last) == spelled(piece)
            });
            if joins {
                joined.pop();
            } else {
                joined.push(piece);
            }
        }
        for piece in joined {
            replacement.push_str(spelled(piece));
        }
        replacement.push_str(&keep_outside(to..end));
        // Trim what the replacement leaves as it was.
        let prefix = old
            .bytes()
            .zip(replacement.bytes())
            .take_while(|(a, b)| a == b)
            .count()
            .min(caret - start - inserted.len());
        let mut prefix = prefix;
        while !old.is_char_boundary(prefix) {
            prefix -= 1;
        }
        Plan {
            range: start + prefix..end,
            inserted: replacement[prefix..].to_owned(),
            caret,
        }
    }

    /// The syntax of spans a selection touches. `seen` holds every source
    /// offset that shows inside the selection, `removed` the source the
    /// selection takes, and `typing` says whether text lands at its start.
    /// A span whose whole text goes, with no text landing in it, loses its
    /// syntax (the second list); a span reaching out of the selection keeps
    /// the syntax inside it (the first list). Both are in source order.
    fn span_syntax(
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
}
