//! Images: claimed insertion, and the keys that treat an image as one unit.
//!
//! An image shows its whole source spelling (`![alt](reference)`) and a view
//! draws its atom as one object. Insertion writes exact source at the caret,
//! inline: `![alt](reference)`, with `<…>` around a reference holding spaces
//! or parentheses, and only when that text reads back, on the line it lands
//! on, as exactly one image with exactly that destination and alt.
use super::super::command::{Command, Edit};
use super::super::Engine;
use crate::lines::{block, line_spans, Kind, Span, SpanKind, TableRole};
use crate::{
    CaretDirection, DisplayOffset, DisplayRange, EditorError, ParagraphKey, Revision, SourceEdit,
    ViewChange,
};
use std::ops::Range;

/// `![alt](reference)` for a vault image reference, or `None` for a reference
/// that is not one and for text holding a control character. Characters
/// that can end or reinterpret the image if later text changes are refused
/// too, though the text may read back today: `<`, `>` and `\` in the
/// reference, and `[`, `]`, `\` and a backtick in the alt.
fn image_text(reference: &str, alt: &str) -> Option<String> {
    if !futo_notes_image::is_vault_image_reference(reference)
        || reference.chars().chain(alt.chars()).any(char::is_control)
        || reference.contains(['<', '>', '\\'])
        || alt.contains(['[', ']', '\\', '`'])
    {
        return None;
    }
    let destination = if reference.contains([' ', '(', ')']) {
        format!("<{reference}>")
    } else {
        reference.to_owned()
    };
    Some(format!("![{alt}]({destination})"))
}

/// Whether `spans` hold one image exactly at `at` of `text`, with exactly
/// `reference` as its destination, `alt` as its alt and no title.
fn is_image(spans: &[Span], text: &str, at: &Range<usize>, reference: &str, alt: &str) -> bool {
    spans.iter().any(|span| {
        span.range == *at
            && matches!(&span.kind, SpanKind::Image { alt: shown, destination, title: None }
                if destination == reference && &text[shown.clone()] == alt)
    })
}

impl Engine {
    /// Insert the vault image `reference` at the caret, replacing a
    /// selection, as one isolated undo step with the caret after the image.
    /// `None` inside code; `InvalidText` when the image would not read back
    /// as written.
    pub(crate) fn insert_image(
        &mut self,
        expected: Revision,
        reference: &str,
        alt: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let text = image_text(reference, alt).ok_or(EditorError::InvalidText)?;
        let Some(command) = self.image_command(&text, reference, alt)? else {
            return Ok(None);
        };
        let change = self.run(expected, |_| Ok(Some(command)), accept)?;
        Ok(change.map(|change| self.view(change)))
    }

    fn image_command(
        &self,
        text: &str,
        reference: &str,
        alt: &str,
    ) -> Result<Option<Command>, EditorError> {
        let plan = self.plan(self.outside_crlf(self.selection), text);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        // Code takes no image: a fence line, or a caret inside inline code.
        let at = plan.range.start - self.line_start(first);
        let in_code_span = self.line(first).spans.iter().any(|span| {
            span.kind == SpanKind::Code && span.range.start < at && at < span.range.end
        });
        if in_code_span
            || (first..=last).any(|index| matches!(self.line(index).line.kind, Kind::Fence { .. }))
        {
            return Ok(None);
        }
        // The named lines as they will read, the image's line checked.
        let base = self.line_start(first);
        let end = self.line_start(last) + self.line(last).text.len();
        let mut after = self.source_slice(base..plan.range.start);
        after.push_str(&plan.inserted);
        after.push_str(&self.source_slice(plan.range.end..end));
        let image = plan.caret - text.len() - base..plan.caret - base;
        let delimiter_below = (last + 1 < self.line_count())
            .then(|| match self.line(last + 1).line.kind {
                Kind::Table {
                    role: TableRole::Delimiter,
                    columns,
                } => Some(columns),
                _ => None,
            })
            .flatten();
        let mut carry = self.line(first).carry.clone();
        let mut start = 0;
        let pieces: Vec<&str> = after.split_inclusive('\n').collect();
        for (k, piece) in pieces.iter().enumerate() {
            let range = start..start + piece.len();
            start = range.end;
            let mut line = block::read_line(&mut carry, piece, 0);
            if !(range.start <= image.start && image.end <= range.end) {
                continue;
            }
            // A delimiter row under the last line makes it a header.
            if let (Some(columns), true) = (delimiter_below, k + 1 == pieces.len()) {
                if carry.header_above.is_some() {
                    line.kind = Kind::Table {
                        role: TableRole::Header,
                        columns,
                    };
                }
            }
            let local = image.start - range.start..image.end - range.start;
            if !is_image(&line_spans(piece, &line), piece, &local, reference, alt) {
                return Err(EditorError::InvalidText);
            }
            return Ok(Some(Command::new(
                vec![Edit::new(plan.range.clone(), plan.inserted.clone())],
                first..last + 1,
                plan.caret..plan.caret,
            )));
        }
        Err(EditorError::InvalidText)
    }

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
