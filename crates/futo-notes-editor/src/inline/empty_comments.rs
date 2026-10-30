//! The standard empty HTML block comment is the narrow list-boundary primitive.
//! Other HTML, inline comments and final lines without a newline remain outside
//! this slice. CommonMark decides whether the source is an HTML block at all.
use pulldown_cmark::{Event, Tag};
use std::ops::Range;

pub(super) fn ranges(events: &[(Event<'_>, Range<usize>)]) -> Vec<Range<usize>> {
    events
        .iter()
        .filter_map(|(event, range)| {
            matches!(event, Event::Start(Tag::HtmlBlock)).then(|| range.clone())
        })
        .collect()
}

pub(super) fn standard(raw: &str) -> bool {
    matches!(raw.trim_matches([' ', '\t']), "<!-- -->" | "<!---->")
}
