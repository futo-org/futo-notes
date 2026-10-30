//! The standard empty HTML block comment is the narrow list-boundary primitive.
//! Other HTML, inline comments and unterminated final lines remain outside this
//! slice. CommonMark decides whether the source is an HTML block at all.
use pulldown_cmark::Event;
use std::ops::Range;

pub(super) fn ranges(events: &[(Event<'_>, Range<usize>)]) -> Vec<Range<usize>> {
    events
        .iter()
        .filter_map(|(event, range)| {
            let Event::Html(text) = event else {
                return None;
            };
            if !text.ends_with('\n') {
                return None;
            }
            let raw = text
                .trim_end_matches(['\r', '\n'])
                .trim_matches([' ', '\t']);
            matches!(raw, "<!-- -->" | "<!---->").then(|| range.clone())
        })
        .collect()
}
