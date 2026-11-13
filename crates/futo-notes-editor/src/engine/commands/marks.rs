//! Inline marks cut by a line break. A mark never crosses a line, so a
//! command that breaks a line inside one closes it before the break and
//! opens it again after.
use crate::lines::{Line, Span};

/// Where a line splits for a caret at `at`, and the marks the split closes
/// on the left and opens again on the right. A caret at a mark's text start
/// splits before the mark, at its text end after it, so a mark is only
/// closed and opened again when the caret is inside its text.
pub(super) fn split(text: &str, line: &Line, spans: &[Span], at: usize) -> (usize, String, String) {
    let marks: Vec<&Span> = spans
        .iter()
        .filter(|span| !span.open.is_empty() && !span.close.is_empty())
        .collect();
    let mut at = at.max(line.content.start);
    for _ in 0..=marks.len() * 2 {
        let out = marks.iter().find_map(|span| {
            if span.open.end == at && span.open.start < at {
                Some(span.open.start)
            } else if span.close.start == at && span.close.end > at {
                Some(span.close.end)
            } else {
                None
            }
        });
        match out {
            Some(moved) => at = moved,
            None => break,
        }
    }
    let mut inside: Vec<&Span> = marks
        .into_iter()
        .filter(|span| span.open.end < at && at < span.close.start)
        .collect();
    inside.sort_by_key(|span| span.open.start);
    let opens: String = inside.iter().map(|span| &text[span.open.clone()]).collect();
    let closes: String = inside
        .iter()
        .rev()
        .map(|span| &text[span.close.clone()])
        .collect();
    (at, closes, opens)
}
