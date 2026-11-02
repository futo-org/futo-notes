//! A paragraph's canonical event bounds, including a tight item's inline run.
use pulldown_cmark::{Event, Tag};
use std::ops::Range;

#[derive(Default)]
pub(super) struct ProseAttribution {
    ranges: Vec<Range<usize>>,
    direct: Option<Range<usize>>,
    opaque_depth: usize,
    paragraph: bool,
    next: usize,
}

fn inline_start(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Subscript
            | Tag::Superscript
            | Tag::Link { .. }
            | Tag::Image { .. }
    )
}
fn inline_end(tag: &pulldown_cmark::TagEnd) -> bool {
    use pulldown_cmark::TagEnd;
    matches!(
        tag,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Subscript
            | TagEnd::Superscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

impl ProseAttribution {
    pub(super) fn observe(&mut self, event: &Event<'_>, span: &Range<usize>) {
        if self.opaque_depth > 0 {
            match event {
                Event::Start(_) => self.opaque_depth += 1,
                Event::End(_) => self.opaque_depth -= 1,
                _ => {}
            }
            return;
        }
        if self.paragraph {
            if matches!(event, Event::End(pulldown_cmark::TagEnd::Paragraph)) {
                self.paragraph = false;
            }
            return;
        }
        match event {
            Event::Start(Tag::Paragraph) => {
                self.flush();
                self.emit(span.clone());
                self.paragraph = true;
            }
            Event::Start(tag) if inline_start(tag) => self.extend(span),
            Event::End(tag) if inline_end(tag) => self.extend(span),
            Event::Text(_)
            | Event::Code(_)
            | Event::InlineHtml(_)
            | Event::InlineMath(_)
            | Event::SoftBreak
            | Event::HardBreak
            | Event::FootnoteReference(_) => self.extend(span),
            Event::Start(Tag::List(_) | Tag::Item | Tag::BlockQuote(_))
            | Event::End(
                pulldown_cmark::TagEnd::List(_)
                | pulldown_cmark::TagEnd::Item
                | pulldown_cmark::TagEnd::BlockQuote(_),
            ) => self.flush(),
            Event::Start(_) => {
                self.flush();
                self.opaque_depth = 1;
            }
            Event::TaskListMarker(_) => {}
            _ => self.flush(),
        }
    }

    fn extend(&mut self, span: &Range<usize>) {
        if let Some(run) = &mut self.direct {
            run.start = run.start.min(span.start);
            run.end = run.end.max(span.end);
        } else {
            self.direct = Some(span.clone());
        }
    }
    fn emit(&mut self, span: Range<usize>) {
        if span.is_empty() {
            return;
        }
        if let Some(last) = self.ranges.last_mut() {
            if span.start <= last.end && last.start <= span.end {
                last.start = last.start.min(span.start);
                last.end = last.end.max(span.end);
                return;
            }
            debug_assert!(
                last.end <= span.start,
                "canonical textblocks are source ordered"
            );
        }
        self.ranges.push(span);
    }
    pub(super) fn flush(&mut self) {
        if let Some(span) = self.direct.take() {
            self.emit(span);
        }
    }
    pub(super) fn owns(&mut self, content: &Range<usize>) -> bool {
        if content.is_empty() {
            return false;
        }
        while self
            .ranges
            .get(self.next)
            .is_some_and(|span| span.end <= content.start)
        {
            self.next += 1;
        }
        self.ranges
            .get(self.next)
            .is_some_and(|span| content.start < span.end && span.start < content.end)
    }
}
