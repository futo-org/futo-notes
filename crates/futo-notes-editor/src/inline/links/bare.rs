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

pub(in crate::inline) fn bare_links(
    source: &str,
) -> (Vec<Span>, crate::inline::references::ReferenceWork) {
    use crate::inline::references::ReferenceWork;
    let (possible, hint_items) = possible_uri(source);
    let mut work = ReferenceWork {
        items: hint_items,
        ..ReferenceWork::default()
    };
    if !possible {
        return (Vec::new(), work);
    }
    #[cfg(test)]
    let primitive = crate::inline::coordinate_work_tests::bare_before();
    #[cfg(test)]
    crate::inline::coordinate_work_tests::bare_visit();
    let options = markdown::ParseOptions {
        constructs: markdown::Constructs {
            gfm_autolink_literal: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let tree =
        markdown::to_mdast(source, &options).expect("CommonMark with GFM literals is infallible");
    work.parsed = source.len();
    let mut spans = Vec::new();
    let mut pending = vec![&tree];
    work.items += 1; // initial root reference stack copy
    while let Some(node) = pending.pop() {
        #[cfg(test)]
        crate::inline::coordinate_work_tests::bare_visit();
        work.items += 1;
        if let markdown::mdast::Node::Link(link) = node {
            // markdown 1.0.0's to_mdast inserts BOTH Link constructors through
            // tail_push, which supplies positions; GFM uses that same path.
            // This is the pinned Rust factory invariant, not JS remark behavior
            // or a claim about arbitrary mdast values. Recheck on pin changes.
            let position = link
                .position
                .as_ref()
                .expect("pinned markdown factory positions every Link");
            let (start, end) = (position.start.offset, position.end.offset);
            work.items += 3; // two source bounds and the source-prefix check
            if !source[start..end].starts_with(['[', '<']) {
                work.copied += link.url.len() + link.title.as_ref().map_or(0, String::len);
                work.items += 2; // emitted Span and retained meaning records
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
            // Existing link labels cannot contain independent nested links.
            continue;
        }
        if let Some(children) = node.children() {
            for child in children.iter().rev() {
                #[cfg(test)]
                crate::inline::coordinate_work_tests::bare_visit();
                work.items += 1;
                pending.push(child);
            }
        }
    }
    #[cfg(test)]
    crate::inline::coordinate_work_tests::bare_query(primitive, hint_items, work.items);
    (spans, work)
}

/// Read only canonical complete-word extent; no origin or phase authority.
pub(crate) fn complete_bare_uri(source: &str) -> (bool, crate::EditWork) {
    let (links, read) = bare_links(source);
    let work = crate::EditWork {
        parsed_source_bytes: read.parsed,
        link_metadata_items: read.items + links.len() + 1,
        link_copied_bytes: read.copied,
        ..crate::EditWork::default()
    };
    let complete =
        links.len() == 1 && links[0].open.start == 0 && links[0].close.end == source.len();
    (complete, work)
}
