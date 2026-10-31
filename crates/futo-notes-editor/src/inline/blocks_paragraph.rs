//! A paragraph's canonical event bounds, including a tight item's inline run.
use pulldown_cmark::{Event, Tag};
use std::ops::Range;

pub(super) struct Textblock {
    pub source: Range<usize>,
    pub boundary: usize,
}

pub(super) fn at(
    events: &[(Event<'_>, Range<usize>)],
    item: usize,
    body: usize,
) -> Option<Textblock> {
    let mut direct_item = false;
    let mut inline_depth = 0;
    let mut run: Option<Range<usize>> = None;
    for (event, span) in events {
        super::visit_container();
        if matches!(event, Event::Start(Tag::Paragraph)) && span.contains(&body) {
            return Some(Textblock {
                source: span.clone(),
                boundary: span.end,
            });
        }
        if !direct_item {
            if matches!(event, Event::Start(Tag::Item))
                && span.start == item
                && span.contains(&body)
            {
                direct_item = true;
            }
            continue;
        }
        let inline = match event {
            Event::Start(
                Tag::Emphasis
                | Tag::Strong
                | Tag::Strikethrough
                | Tag::Subscript
                | Tag::Superscript
                | Tag::Link { .. }
                | Tag::Image { .. },
            ) => {
                inline_depth += 1;
                true
            }
            Event::End(_) if inline_depth > 0 => {
                inline_depth -= 1;
                true
            }
            Event::Text(_)
            | Event::Code(_)
            | Event::InlineHtml(_)
            | Event::SoftBreak
            | Event::HardBreak
            | Event::FootnoteReference(_) => true,
            _ => false,
        };
        if inline {
            if let Some(run) = &mut run {
                run.end = run.end.max(span.end);
            } else {
                run = Some(span.clone());
            }
        } else {
            // The first child block/container or this item's end terminates
            // its direct inline run. Never borrow a nested child's text.
            if let Some(source) = run.take().filter(|run| run.contains(&body)) {
                let boundary = if matches!(event, Event::End(pulldown_cmark::TagEnd::Item)) {
                    span.end
                } else {
                    span.start
                };
                return Some(Textblock { source, boundary });
            }
            direct_item = false;
        }
    }
    None
}
