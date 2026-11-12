//! Links: inspecting, setting, relabelling and removing them. A link is
//! `[text](destination)` on one line; it cannot cross a line, so a
//! selection over several lines links each line's text (and each table
//! cell's) on its own. A label is written as typed, like any typed text.
use super::super::super::command::Command;
use super::super::super::line::Entry;
use super::super::super::{store, Engine};
use super::draft::{glyph_range, glyphs, inside, matches, shape, Draft, Expect, LINK, URL};
use super::Accept;
use crate::lines::{Span, SpanKind};
use crate::{
    Affinity, DisplayOffset, DisplayRange, EditorError, LinkDescription, Revision, ViewChange,
};
use std::collections::BTreeMap;
use std::ops::Range;

mod write;

/// A link the selection is in.
struct Found {
    index: usize,
    span: Span,
    /// Its text, in display offsets.
    label: DisplayRange,
}

/// Ways to write `destination` inside `(…)`, plainest first. The line is
/// read back to choose: the first that reads as the destination wins.
fn spellings(destination: &str) -> Vec<String> {
    let escaped: String = destination
        .chars()
        .flat_map(|ch| {
            let escape = matches!(ch, '(' | ')' | '\\' | '<' | '>');
            escape.then_some('\\').into_iter().chain([ch])
        })
        .collect();
    let angled: String = destination
        .chars()
        .flat_map(|ch| {
            let escape = matches!(ch, '<' | '>' | '\\');
            escape.then_some('\\').into_iter().chain([ch])
        })
        .collect();
    vec![
        destination.to_owned(),
        format!("<{destination}>"),
        escaped,
        format!("<{angled}>"),
    ]
}

/// Where the destination is written inside a link's closing `](…)`.
fn destination_in(close: &str) -> Range<usize> {
    let bytes = close.as_bytes();
    let mut at = 2;
    while matches!(bytes.get(at), Some(b' ' | b'\t')) {
        at += 1;
    }
    let start = at;
    if bytes.get(at) == Some(&b'<') {
        while at < bytes.len() && bytes[at] != b'>' {
            at += if bytes[at] == b'\\' { 2 } else { 1 };
        }
        return start..(at + 1).min(bytes.len());
    }
    let mut depth = 0usize;
    while let Some(&byte) = bytes.get(at) {
        match byte {
            b'\\' => at += 2,
            b'(' => {
                depth += 1;
                at += 1;
            }
            b')' if depth == 0 => break,
            b')' => {
                depth -= 1;
                at += 1;
            }
            b' ' | b'\t' => break,
            _ => at += 1,
        }
    }
    start..at.min(bytes.len())
}

/// Whether `entry` reads a link to `destination` over source `range`.
fn links_to(entry: &Entry, range: &Range<usize>, destination: &str) -> bool {
    entry.spans.iter().any(|span| {
        let target = match &span.kind {
            SpanKind::Link { destination, .. } | SpanKind::Url { destination } => destination,
            _ => return false,
        };
        target == destination && span.range == *range
    })
}

impl Engine {
    /// The link or web address whose text holds display `range`, on one
    /// line. A caret at its edge takes the side its affinity names.
    fn link_at(&self, range: DisplayRange) -> Option<Found> {
        let (index, before) = self.line_at_display(store::display, range.start.0);
        let entry = self.store.get(index);
        let to_display = |at: usize| before.display + entry.to_display(at);
        entry.spans.iter().find_map(|span| {
            if !matches!(span.kind, SpanKind::Link { .. } | SpanKind::Url { .. }) {
                return None;
            }
            let text = inside(span);
            let (start, end) = (to_display(text.start), to_display(text.end));
            let at = range.start.0;
            let holds = if range.start == range.end {
                (start < at && at < end)
                    || (at == start && self.affinity == Affinity::Forward)
                    || (at == end && self.affinity == Affinity::Backward)
            } else {
                start <= at && range.end.0 <= end
            };
            holds.then(|| Found {
                index,
                span: span.clone(),
                label: DisplayRange {
                    start: DisplayOffset(start),
                    end: DisplayOffset(end),
                },
            })
        })
    }

    pub(crate) fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<LinkDescription>, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        Ok(self.link_at(range).map(|found| {
            let (destination, title) = match found.span.kind {
                SpanKind::Link { destination, title } => (destination, title),
                SpanKind::Url { destination } => (destination, None),
                _ => unreachable!("link_at finds links"),
            };
            LinkDescription {
                range: found.label,
                destination,
                title,
            }
        }))
    }

    /// Set the destination of the link at `range`, or link the selected
    /// text, or insert a link at a caret; an empty destination removes the
    /// link and keeps its text.
    pub(crate) fn set_link_view(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        if destination.contains(['\r', '\n', '\0']) {
            return Err(EditorError::InvalidText);
        }
        self.link_view(expected, range, None, destination, accept)
    }

    /// Write the link at `range` (or over it) with text `label` and
    /// `destination`, as one action. An unchanged label keeps the text's
    /// formatting; an empty destination leaves the label as plain text.
    pub(crate) fn edit_link_view(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        label: &str,
        destination: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        if label.contains('\0') || destination.contains(['\r', '\n', '\0']) {
            return Err(EditorError::InvalidText);
        }
        self.link_view(expected, range, Some(label), destination, accept)
    }

    fn link_view(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        label: Option<&str>,
        destination: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let mut work = 0;
        let change = self.run(
            expected,
            |engine| engine.link_command(range, label, destination, &mut work),
            accept,
        )?;
        Ok(change.map(|change| {
            let mut view = self.view(change);
            view.work.parsed_source_bytes += work;
            view
        }))
    }

    fn link_command(
        &self,
        range: DisplayRange,
        label: Option<&str>,
        destination: &str,
        work: &mut usize,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let found = self.link_at(range);
        let target = found.as_ref().map_or(range, |found| found.label);
        let label = label.filter(|label| {
            target.start == target.end || self.display_slice(target.start.0..target.end.0) != *label
        });
        if let Some(label) = label {
            if label.contains(['\r', '\n']) {
                return Err(EditorError::InvalidText);
            }
            return self.relabel(found, target, label, destination, work);
        }
        let Some(found) = found else {
            if destination.is_empty() {
                return Ok(None);
            }
            if range.start == range.end {
                return self.insert_link(range, destination, work);
            }
            return self.link_selection(range, destination, work);
        };
        let entry = self.store.get(found.index);
        let draft = Draft::of(entry);
        let old = glyphs(entry);
        let line_shape = shape(entry);
        let span = &found.span;
        let current = match &span.kind {
            SpanKind::Link { destination, .. } | SpanKind::Url { destination } => destination,
            _ => unreachable!("link_at finds links"),
        };
        if current == destination {
            return Ok(None);
        }
        let label_glyphs = glyph_range(&old, &inside(span));
        let candidates: Vec<String> = match (&span.kind, destination.is_empty()) {
            (SpanKind::Url { .. }, true) => return Ok(None),
            (SpanKind::Link { .. }, true) => {
                let mut text = entry.text.clone();
                text.replace_range(span.close.clone(), "");
                text.replace_range(span.open.clone(), "");
                vec![text]
            }
            (SpanKind::Link { .. }, false) => {
                let close = &entry.text[span.close.clone()];
                let at = destination_in(close);
                spellings(destination)
                    .into_iter()
                    .map(|spelled| {
                        let mut close = close.to_owned();
                        close.replace_range(at.clone(), &spelled);
                        let mut text = entry.text.clone();
                        text.replace_range(span.close.clone(), &close);
                        text
                    })
                    .collect()
            }
            // A web address becomes the link's text; `<…>` loses its brackets.
            (_, false) => spellings(destination)
                .into_iter()
                .map(|spelled| {
                    let address = &entry.text[inside(span)];
                    let mut text = entry.text.clone();
                    text.replace_range(span.range.clone(), &format!("[{address}]({spelled})"));
                    text
                })
                .collect(),
            _ => return Ok(None),
        };
        let expect: Vec<Expect> = old
            .iter()
            .enumerate()
            .map(|(i, glyph)| {
                let mut want = Expect::same(glyph);
                if label_glyphs.contains(&i) {
                    want.style &= !(LINK | URL);
                    if !destination.is_empty() {
                        want.style |= LINK;
                    }
                }
                want
            })
            .collect();
        for text in candidates {
            let candidate = draft.with_text(text);
            let read = candidate.read(work);
            let linked = destination.is_empty()
                || read.spans.iter().any(|span| {
                    matches!(&span.kind, SpanKind::Link { destination: to, .. } if to == destination)
                });
            if shape(&read) == line_shape && matches(&glyphs(&read), &expect) && linked {
                let mut edited = BTreeMap::new();
                edited.insert(found.index, (candidate, read));
                return Ok(self.rewrite(range, edited));
            }
        }
        Err(EditorError::UnrepresentableFormat)
    }
}
