//! GFM owns literal extent/meaning; the borrowed hint only avoids useless parses.
use crate::inline::row::{LinkMeaning, Span, SpanKind};

fn possible_uri(source: &str) -> (bool, usize) {
    let bytes = source.as_bytes();
    let mut visits = 0;
    for (at, &byte) in bytes.iter().enumerate() {
        visits += 1;
        if matches!(byte, b':' | b'@') {
            return (true, visits);
        }
        if matches!(byte, b'w' | b'W') {
            if let Some(prefix) = bytes.get(at..).and_then(|tail| tail.get(..4)) {
                if prefix.iter().zip(b"www.").all(|(actual, expected)| {
                    visits += 1;
                    actual.eq_ignore_ascii_case(expected)
                }) {
                    return (true, visits);
                }
            }
        }
    }
    (false, visits)
}

pub(in crate::inline) fn bare_links(source: &str) -> (Vec<Span>, usize, usize) {
    let (possible, hint_items) = possible_uri(source);
    if !possible {
        return (Vec::new(), 0, hint_items);
    }
    let options = markdown::ParseOptions {
        constructs: markdown::Constructs {
            gfm_autolink_literal: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let tree =
        markdown::to_mdast(source, &options).expect("CommonMark with GFM literals is infallible");
    let mut spans = Vec::new();
    let mut pending = vec![&tree];
    let mut cursor = 0;
    while let Some(node) = pending.pop() {
        if let markdown::mdast::Node::Link(link) = node {
            // GFM's post-parse text transform can leave a literal after a
            // bracket without positions, just as the shipping remark parser
            // does. Its parsed visible text is the literal source to locate.
            let shown: String = link.children.iter().map(ToString::to_string).collect();
            let bounds = link
                .position
                .as_ref()
                .map(|position| (position.start.offset, position.end.offset))
                .or_else(|| {
                    source[cursor..]
                        .find(&shown)
                        .map(|at| (cursor + at, cursor + at + shown.len()))
                });
            if let Some((start, end)) = bounds {
                cursor = end;
                if !source[start..end].starts_with(['[', '<']) {
                    spans.push(Span {
                        kind: SpanKind::Link(std::sync::Arc::new(LinkMeaning {
                            destination: link.url.clone(),
                            title: link.title.clone(),
                            reference: None,
                        })),
                        open: start..start,
                        close: end..end,
                    });
                }
            }
            // Existing link labels cannot contain independent nested links.
            continue;
        }
        if let Some(children) = node.children() {
            pending.extend(children.iter().rev());
        }
    }
    (spans, source.len(), hint_items)
}

/// Read only canonical complete-word extent; no origin or phase authority.
pub(crate) fn complete_bare_uri(source: &str) -> (bool, crate::EditWork) {
    let (links, parsed, hints) = bare_links(source);
    let mut work = crate::EditWork::default();
    work.parsed_source_bytes = parsed;
    work.link_metadata_items = hints + links.len() + 1;
    for span in &links {
        if let SpanKind::Link(meaning) = &span.kind {
            work.link_copied_bytes +=
                meaning.destination.len() + meaning.title.as_ref().map_or(0, String::len);
        }
    }
    let complete =
        links.len() == 1 && links[0].open.start == 0 && links[0].close.end == source.len();
    (complete, work)
}
