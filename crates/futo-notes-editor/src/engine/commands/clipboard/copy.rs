//! Copy: the exact source of a display selection.
use super::super::super::{store, Engine};
use crate::lines::Span;
use crate::DisplayRange;

/// A mark a selection boundary can cut: one with syntax on both sides of
/// its text (bold, italic, strikethrough, code, link).
fn is_mark(span: &Span) -> bool {
    !span.open.is_empty() && !span.close.is_empty()
}

impl Engine {
    /// The selection's source. A selection starting at a line's display
    /// start and reaching its end carries the line's markers; one ending at
    /// a line's display end carries the closing syntax there. A mark a
    /// boundary cuts is closed or opened again with its own spelling,
    /// outside edge spaces and tabs; spaces and tabs alone get no marks. The
    /// first line's leading whitespace comes off every copied line.
    pub(super) fn copied(&self, range: DisplayRange) -> String {
        let (s, e) = (range.start.0, range.end.0);
        if s >= e {
            return String::new();
        }
        let (first, before) = self.line_at_display(store::display, s);
        let whole_start = s == before.display && e >= before.display + self.line(first).shown_len();
        let (last, after) = self.line_at_display(store::display, e);
        let whole_end = e == after.display + self.line(last).shown_len();
        let tight_start = self.source_bounds(s).1;
        let (tight_end, wide_end) = self.source_bounds(e);
        let physical = self.line_start(first);
        let start = if whole_start { physical } else { tight_start };
        let end = if whole_end { wide_end } else { tight_end }.max(start);
        let mut body = self.source_slice(start..end);
        let indent = self
            .source_slice(physical..tight_start.max(physical))
            .chars()
            .take_while(|c| matches!(c, ' ' | '\t'))
            .count();
        if indent > 0 {
            body = dedent(&body, if whole_start { indent } else { 0 }, indent);
        }
        let skip = body.len()
            - if whole_start {
                body.trim_start_matches([' ', '\t', '>'])
            } else {
                body.trim_start_matches([' ', '\t'])
            }
            .len();
        let keep = if whole_end {
            body.len()
        } else {
            body.trim_end_matches([' ', '\t']).len().max(skip)
        };
        let (opens, closes) = if skip < keep {
            self.cut_marks(start, end)
        } else {
            Default::default()
        };
        let mut out = String::with_capacity(body.len() + opens.len() + closes.len());
        out.push_str(&body[..skip]);
        out.push_str(&opens);
        out.push_str(&body[skip..keep]);
        out.push_str(&closes);
        out.push_str(&body[keep..]);
        out
    }

    /// The marks a copied source range `start..end` cuts: the openings of
    /// marks open across `start`, and the closings of marks open across
    /// `end`, each in source order.
    fn cut_marks(&self, start: usize, end: usize) -> (String, String) {
        let mut opens: Vec<(usize, String)> = Vec::new();
        let mut closes: Vec<(usize, String)> = Vec::new();
        let marks = |at: usize| {
            let index = self.line_of(at);
            let base = self.line_start(index);
            let entry = self.line(index);
            entry
                .spans
                .iter()
                .filter(|span| is_mark(span))
                .map(move |span| {
                    let text =
                        |range: &std::ops::Range<usize>| entry.text[range.clone()].to_owned();
                    (
                        base + span.open.start..base + span.open.end,
                        text(&span.open),
                        base + span.close.start..base + span.close.end,
                        text(&span.close),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (open, open_text, close, _) in marks(start) {
            if open.end <= start && start <= close.start && close.start < end {
                opens.push((open.start, open_text));
            }
        }
        for (open, open_text, close, close_text) in marks(end) {
            if open.end <= end && end <= close.start && open.start >= start {
                closes.push((close.start, close_text));
            } else if open.end <= start && end <= close.start {
                opens.push((open.start, open_text));
                closes.push((close.start, close_text));
            }
        }
        let joined = |mut pieces: Vec<(usize, String)>| {
            pieces.sort();
            pieces.dedup();
            pieces.into_iter().map(|(_, text)| text).collect()
        };
        (joined(opens), joined(closes))
    }
}

/// `text` with up to `later` leading spaces or tabs taken off each line
/// after the first, and up to `first` off the first.
fn dedent(text: &str, first: usize, later: usize) -> String {
    let mut out = String::with_capacity(text.len());
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let limit = if index == 0 { first } else { later };
        let mut skipped = 0;
        out.push_str(line.trim_start_matches(|c: char| {
            let skip = skipped < limit && matches!(c, ' ' | '\t');
            skipped += usize::from(skip);
            skip
        }));
    }
    out
}
