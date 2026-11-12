//! GFM autolink literals in pulldown's inline text; the borrowed hint only
//! avoids useless parses. pulldown has no literal extension, and the
//! markdown crate's tree builder panicked on some notes (#283).
use crate::lines::url as literal;
use crate::inline::row::{LinkMeaning, Span, SpanKind};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use std::ops::Range;

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

fn inline(event: &Event<'_>) -> bool {
    match event {
        Event::Start(tag) => matches!(
            tag,
            Tag::Emphasis
                | Tag::Strong
                | Tag::Strikethrough
                | Tag::Superscript
                | Tag::Subscript
                | Tag::Link { .. }
                | Tag::Image { .. }
        ),
        Event::End(tag) => matches!(
            tag,
            TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Superscript
                | TagEnd::Subscript
                | TagEnd::Link
                | TagEnd::Image
        ),
        Event::Text(_)
        | Event::Code(_)
        | Event::InlineMath(_)
        | Event::InlineHtml(_)
        | Event::FootnoteReference(_)
        | Event::SoftBreak
        | Event::HardBreak
        | Event::TaskListMarker(_) => true,
        _ => false,
    }
}

type Found = Vec<(usize, usize, literal::Kind)>;

/// Literal ranges and kinds, in source order, for one block's inline events.
/// As in markdown-rs, `www.`/`http` literals start in plain text outside link
/// labels and image alts and read raw source; addresses are then found in
/// each remaining run of plain text.
fn block_literals(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
    heading: bool,
    found: &mut Found,
) {
    let bytes = source.as_bytes();
    // A paragraph's content keeps its trailing blanks; a heading's does not.
    let mut end = events.iter().map(|(_, range)| range.end).max().unwrap_or(0);
    while !heading && matches!(bytes.get(end), Some(b' ' | b'\t')) {
        end += 1;
    }
    let content = literal::Content { text: source, end };
    let raw = |event: &Event<'_>, range: &Range<usize>| match event {
        Event::Text(text) => source.get(range.clone()) == Some(text.as_ref()),
        _ => false,
    };
    let mut nested = 0usize;
    let mut line = events.first().map_or(0, |(_, range)| range.start);
    let mut consumed = 0;
    let mut index = 0;
    while let Some((event, range)) = events.get(index) {
        index += 1;
        match event {
            Event::Start(Tag::Link { .. } | Tag::Image { .. }) => nested += 1,
            Event::End(TagEnd::Link | TagEnd::Image) => nested = nested.saturating_sub(1),
            Event::SoftBreak | Event::HardBreak => {
                line = events.get(index).map_or(range.end, |(_, next)| next.start);
            }
            _ => {}
        }
        if nested > 0 || !raw(event, range) {
            continue;
        }
        // An escaped character is its own token, not plain text.
        let before = index.checked_sub(2).and_then(|i| events.get(i));
        let escaped = range.start.checked_sub(1).is_some_and(|slash| {
            bytes.get(slash) == Some(&b'\\') && before.is_none_or(|(_, before)| before.end <= slash)
        });
        // Contiguous plain text is one run.
        let mut run_end = range.end;
        while let Some((next, next_range)) = events.get(index) {
            if next_range.start != run_end || !raw(next, next_range) {
                break;
            }
            run_end = next_range.end;
            index += 1;
        }
        let mut data = (range.start + usize::from(escaped)).max(consumed);
        let mut at = data;
        while at < run_end {
            // A line's first byte follows its line ending, never a prefix.
            let previous = at.checked_sub(1).filter(|_| at != line);
            if let Some((stop, kind)) =
                content.literal(at, previous.and_then(|p| bytes.get(p).copied()))
            {
                run_emails(bytes, data..at, found);
                found.push((at, stop, kind));
                (consumed, data, at) = (stop, stop, stop);
            } else {
                at += 1;
            }
        }
        if data < run_end {
            run_emails(bytes, data..run_end, found);
        }
    }
}

fn run_emails(bytes: &[u8], run: Range<usize>, found: &mut Found) {
    let Some(data) = bytes.get(run.clone()) else {
        return;
    };
    let mut local = Vec::new();
    literal::emails(data, &mut local);
    found.extend(
        local
            .into_iter()
            .map(|(start, end, kind)| (run.start + start, run.start + end, kind)),
    );
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
    let events: Vec<_> = Parser::new_ext(source, crate::inline::row::parser_options())
        .into_offset_iter()
        .collect();
    work.parsed = source.len();
    let mut found = Found::new();
    let mut code = false;
    let mut index = 0;
    while let Some((event, _)) = events.get(index) {
        let start = index;
        index += 1;
        match event {
            Event::Start(Tag::CodeBlock(_)) => code = true,
            Event::End(TagEnd::CodeBlock) => code = false,
            event if !code && inline(event) => {
                while events.get(index).is_some_and(|(event, _)| inline(event)) {
                    index += 1;
                }
                let heading = start
                    .checked_sub(1)
                    .is_some_and(|i| matches!(events[i].0, Event::Start(Tag::Heading { .. })));
                block_literals(source, &events[start..index], heading, &mut found);
            }
            _ => {}
        }
        for _ in start..index {
            work.items += 1;
        }
    }
    let spans = found
        .into_iter()
        .filter_map(|(start, end, kind)| {
            let text = source.get(start..end)?;
            let destination = format!("{}{text}", kind.prefix());
            work.copied += destination.len();
            work.items += 2; // emitted Span and retained meaning record
            Some(Span {
                kind: SpanKind::Link(std::sync::Arc::new(LinkMeaning {
                    destination,
                    title: None,
                    reference: None,
                })),
                open: start..start,
                close: end..end,
            })
        })
        .collect();
    (spans, work)
}
