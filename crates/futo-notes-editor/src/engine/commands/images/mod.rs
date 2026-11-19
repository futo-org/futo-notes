//! Images: claimed insertion (`insert`), and the keys that treat an image as
//! one unit.
//!
//! An image shows its whole source spelling (`![alt](reference)`) and a view
//! draws its atom as one object.
mod insert;

use super::super::command::{Command, Edit};
use super::super::Engine;
use crate::lines::{Span, SpanKind};
use crate::{CaretDirection, DisplayOffset, DisplayRange, EditorError, ParagraphKey};
use std::ops::Range;

/// Whether a mark other than the image at `image` holds it (a link around
/// it, bold around it): taking the image out alone would leave that mark
/// empty, and a line break inside it would split it.
pub(super) fn inside_another_mark(spans: &[Span], image: &Range<usize>) -> bool {
    spans.iter().any(|span| {
        span.range != *image && span.range.start <= image.start && image.end <= span.range.end
    })
}

/// Whether line `text` (read as `spans`, `content` its content range) shows
/// anything besides `image` before it and after it: only what a reader sees
/// counts, so markers, whitespace and hidden syntax (the `[](u)` of a link
/// with no text) do not.
pub(super) fn shows_around(
    text: &str,
    spans: &[Span],
    content: &Range<usize>,
    image: &Range<usize>,
) -> (bool, bool) {
    let hidden = |at: usize| {
        spans
            .iter()
            .any(|span| span.open.contains(&at) || span.close.contains(&at))
    };
    let shows = |range: Range<usize>| {
        text.get(range.clone()).is_some_and(|piece| {
            piece
                .char_indices()
                .any(|(at, ch)| !ch.is_whitespace() && !hidden(range.start + at))
        })
    };
    (
        shows(content.start..image.start),
        shows(image.end..content.end),
    )
}

impl Engine {
    /// Keys around an image: a caret's Backspace or Delete whose one-grapheme
    /// step reaches into an image removes the whole image; Enter on a
    /// selection that is exactly one image acts after it.
    pub(super) fn image_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => {
                if range.start == range.end
                    || !self.images_in(range.start.0, range.end.0).contains(&range)
                {
                    return Ok(None);
                }
                let after = DisplayRange {
                    start: range.end,
                    end: range.end,
                };
                match self.key_command(after, key)? {
                    Some(command) => Ok(Some(command)),
                    None => self.typed_key(after, key),
                }
            }
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::Delete
                if range.start == range.end =>
            {
                let direction = if key == ParagraphKey::Delete {
                    CaretDirection::Forward
                } else {
                    CaretDirection::Backward
                };
                let at = range.start.0;
                let stop = self.grapheme_stop(at, direction);
                let (mut start, mut end) = (at.min(stop), at.max(stop));
                let mut found = false;
                for image in self.images_in(start, end) {
                    if image.start.0 < end && image.end.0 > start {
                        start = start.min(image.start.0);
                        end = end.max(image.end.0);
                        found = true;
                    }
                }
                if !found {
                    return Ok(None);
                }
                let whole = DisplayRange {
                    start: DisplayOffset(start),
                    end: DisplayOffset(end),
                };
                let plan = self.plan(whole, "");
                let first = self.line_of(plan.range.start);
                let last = self.line_of(plan.range.end);
                Ok(Some(Command::new(
                    vec![Edit::new(plan.range, plan.inserted)],
                    first..last + 1,
                    plan.caret..plan.caret,
                )))
            }
            _ => Ok(None),
        }
    }

    /// A caret strictly inside an image moved to the image's nearer edge
    /// (after, on a tie): an atom's only caret stops are before and after
    /// it, so input at a caret never lands in its hidden source. A selection
    /// touching any part of an image includes the whole atom.
    pub(crate) fn outside_images(&self, range: DisplayRange) -> DisplayRange {
        if range.start != range.end {
            let mut whole = range;
            for image in self.images_in(range.start.0, range.end.0) {
                if image.start.0 < range.end.0 && range.start.0 < image.end.0 {
                    whole.start.0 = whole.start.0.min(image.start.0);
                    whole.end.0 = whole.end.0.max(image.end.0);
                }
            }
            return whole;
        }
        let at = range.start.0;
        let Some(image) = self
            .images_in(at, at)
            .into_iter()
            .find(|image| image.start.0 < at && at < image.end.0)
        else {
            return range;
        };
        let edge = if at - image.start.0 < image.end.0 - at {
            image.start
        } else {
            image.end
        };
        DisplayRange {
            start: edge,
            end: edge,
        }
    }

    /// The display ranges of the images on the lines showing display offsets
    /// `start` and `end`.
    fn images_in(&self, start: usize, end: usize) -> Vec<DisplayRange> {
        let (first, _) = self.line_at_display(super::super::store::display, start);
        let (last, _) = self.line_at_display(super::super::store::display, end);
        let mut images = Vec::new();
        for index in first..=last {
            let entry = self.line(index);
            let before = self.store.before(index);
            for span in &entry.spans {
                if matches!(span.kind, SpanKind::Image { .. }) {
                    images.push(DisplayRange {
                        start: DisplayOffset(before.display + entry.to_display(span.range.start)),
                        end: DisplayOffset(before.display + entry.to_display(span.range.end)),
                    });
                }
            }
        }
        images
    }
}
