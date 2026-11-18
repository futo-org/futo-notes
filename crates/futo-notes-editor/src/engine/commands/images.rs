//! Image insertion, claimed when it began. The keys that treat an image as
//! one unit are the atoms' (`atoms.rs`).
//!
//! An image shows its whole source spelling (`![alt](reference)`) and a view
//! draws its atom as one object. Insertion writes exact source at the caret,
//! inline: `![alt](reference)`, with `<…>` around a reference holding spaces
//! or parentheses, and only when that text reads back, on the line it lands
//! on, as exactly one image with exactly that destination and alt.
use super::super::command::{Command, Edit};
use super::super::Engine;
use crate::lines::{block, line_spans, Kind, Span, SpanKind, TableRole};
use crate::{EditorError, Revision, SourceEdit, ViewChange};
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
}
