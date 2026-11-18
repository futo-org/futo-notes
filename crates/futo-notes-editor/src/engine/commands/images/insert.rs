//! Image insertion. Insertion writes exact source at the caret:
//! `![alt](reference)`, with `<…>` around a reference holding spaces or
//! parentheses, on a line of its own when the caret's line is a plain line or
//! a heading with other content (`own_line`) and the lines the split leaves
//! read as they should (`split_reads`), else inline, and only when that
//! text reads back, with the whole note read after the edit, as exactly one
//! image with exactly that destination and alt (`Command::image`).
use super::super::super::command::{Command, Edit, Written};
use super::super::super::Engine;
use super::inside_another_mark;
use crate::lines::{block, line_spans, Kind, Line, Span, SpanKind, TableRole};
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

/// The edit writing `new` over `old`, which starts at source `at`, without
/// the bytes the two share at either end.
fn trimmed(at: usize, old: &str, new: &str) -> Edit {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let (old_rest, new_rest) = (&old[prefix..], &new[prefix..]);
    let mut suffix = old_rest
        .bytes()
        .rev()
        .zip(new_rest.bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old_rest.is_char_boundary(old_rest.len() - suffix)
        || !new_rest.is_char_boundary(new_rest.len() - suffix)
    {
        suffix -= 1;
    }
    Edit::new(
        at + prefix..at + old.len() - suffix,
        &new_rest[..new_rest.len() - suffix],
    )
}

/// Where an image inserted on a line goes on a line of its own.
enum Side {
    Before,
    After,
}

/// Where an image written at `at` of `line` (one line, `shown` its text)
/// goes on a line of its own: on an unindented, unquoted plain line or a
/// heading that has content besides it, before the line when nothing is
/// before it there, else after what is. `None` keeps it inline: on any
/// other line, alone on its line, or inside another mark, which a line of
/// its own would split.
fn own_line(shown: &str, line: &Line, at: usize) -> Option<Side> {
    if line.quote > 0 || !matches!(line.kind, Kind::Plain { indent: 0 } | Kind::Heading { .. }) {
        return None;
    }
    let spans = line_spans(shown, line);
    let image = spans
        .iter()
        .find(|span| span.range.start == at && matches!(span.kind, SpanKind::Image { .. }))?;
    if inside_another_mark(&spans, &image.range) {
        return None;
    }
    let content = &line.content;
    let before = shown
        .get(content.start..at)
        .is_none_or(|text| text.trim().is_empty());
    let behind = shown
        .get(image.range.end..content.end)
        .is_none_or(|text| text.trim().is_empty());
    match (before, behind) {
        (true, true) => None,
        (true, false) => Some(Side::Before),
        _ => Some(Side::After),
    }
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
        // The named lines as they will read with the image inline.
        let base = self.line_start(first);
        let end = self.line_start(last) + self.line(last).text.len();
        let mut after = self.source_slice(base..plan.range.start);
        after.push_str(&plan.inserted);
        after.push_str(&self.source_slice(plan.range.end..end));
        let image = plan.caret - text.len() - base..plan.caret - base;
        let lines = first..last + 1;
        let (piece, line) = self
            .image_line(first, last, &after, &image)
            .ok_or(EditorError::InvalidText)?;
        let ending = self.line_ending_near(first);
        // Spaces right after the image go with the line before the split:
        // a line of its own starting with them would be indented.
        let rest = &after[image.end..piece.start + line.range.end];
        let spaces = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        let gap = &after[image.end..image.end + spaces];
        // What the replacement writes around the image: syntax a selection
        // leaves (a bold opener kept after it, `**c**`) is no part of the
        // image, which `own_line` reads where it lands.
        let lead = image.start - (plan.range.start - base);
        let pre = &plan.inserted[..lead];
        let post = &plan.inserted[lead + text.len()..];
        // The spaces after the image, in what the replacement writes and in
        // the source after it.
        let in_post = spaces.min(post.len());
        let replaced = plan.range.start..plan.range.end + spaces - in_post;
        let side =
            own_line(&after[piece.clone()], &line, image.start - piece.start).filter(|side| {
                // The lines the split leaves, as the named lines would read.
                let (moved, kept, rest) = match side {
                    Side::Before => {
                        let own = format!("{text}{gap}{ending}");
                        let moved = [
                            &after[..piece.start],
                            &own,
                            &after[piece.start..image.start],
                            &after[image.end + spaces..],
                        ]
                        .concat();
                        (moved, piece.start + own.len(), None)
                    }
                    Side::After => {
                        let own = format!("{ending}{text}{ending}");
                        let split = image.end + spaces;
                        let moved = [
                            &after[..image.start],
                            &after[image.end..split],
                            &own,
                            &after[split..],
                        ]
                        .concat();
                        let rest = image.start + spaces + own.len();
                        (moved, piece.start, Some(rest))
                    }
                };
                self.split_reads(first, last, &moved, kept, rest, &line)
            });
        let (edits, at, caret) = match side {
            None => (
                vec![Edit::new(plan.range.clone(), plan.inserted.clone())],
                plan.caret - text.len(),
                plan.caret,
            ),
            // Before the line, the caret where the image would have been.
            Some(Side::Before) => {
                let at = base + piece.start;
                let own = format!("{text}{gap}{ending}");
                let caret = base + image.start + own.len();
                let mut edits = vec![Edit::insert(at, own)];
                let left = format!("{pre}{}", &post[in_post..]);
                if !replaced.is_empty() || !left.is_empty() {
                    edits.push(Edit::new(replaced, left));
                }
                (edits, at, caret)
            }
            // After the text before it and the spaces, the caret at the start
            // of the line that follows: the rest of its line, or a new empty
            // one.
            Some(Side::After) => {
                let own = format!("{ending}{text}{ending}");
                let old = self.source_slice(replaced.clone());
                let new = format!("{pre}{gap}{own}{}", &post[in_post..]);
                let at = base + image.start + spaces + ending.len();
                let caret = base + image.start + spaces + own.len();
                (vec![trimmed(replaced.start, &old, &new)], at, caret)
            }
        };
        let mut command = Command::new(edits, lines, caret..caret);
        command.image = Some(Written {
            range: at..at + text.len(),
            destination: reference.to_owned(),
            alt: alt.to_owned(),
        });
        Ok(Some(command))
    }

    /// Whether the lines an image put on a line of its own leaves read as
    /// they should, with the line below the named ones `first..=last`: the
    /// line starting at `kept` of `moved` (their text after the split) as
    /// `line` did with the image inline, and the line starting at `rest`,
    /// the text after the image, as a plain line or an empty one. A split
    /// must never expose a marker (`# Title‸ - [ ] ship`) or leave a frame
    /// line (`---‸x`).
    fn split_reads(
        &self,
        first: usize,
        last: usize,
        moved: &str,
        kept: usize,
        rest: Option<usize>,
        line: &Line,
    ) -> bool {
        let mut text = moved.to_owned();
        if last + 1 < self.line_count() {
            text.push_str(&self.line(last + 1).text);
        }
        let mut carry = self.line(first).carry.clone();
        let mut lines: Vec<Line> = Vec::new();
        let mut start = 0;
        loop {
            let read = block::read_line(&mut carry, &text, start);
            let last = read.ending == 0;
            start = read.end();
            block::place(&mut lines, read);
            if last {
                break;
            }
        }
        let at = |offset: usize| lines.iter().find(|read| read.range.start == offset);
        let kept_holds =
            at(kept).is_some_and(|read| (&read.kind, read.quote) == (&line.kind, line.quote));
        let rest_holds = rest.is_none_or(|offset| {
            at(offset).is_some_and(|read| {
                read.quote == 0 && matches!(read.kind, Kind::Plain { indent: 0 } | Kind::Blank)
            })
        });
        kept_holds && rest_holds
    }

    /// The line of `after` (the text of lines `first..=last` with an edit
    /// made) that holds `image`: its range in `after` and how it reads.
    fn image_line(
        &self,
        first: usize,
        last: usize,
        after: &str,
        image: &Range<usize>,
    ) -> Option<(Range<usize>, Line)> {
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
            return Some((range, line));
        }
        None
    }

    /// Whether the image a command wrote reads, with the whole note read
    /// after its edits, as exactly one image with exactly its destination
    /// and alt.
    pub(crate) fn reads_as_image(&self, image: &Written) -> bool {
        let index = self.line_of(image.range.start);
        let entry = self.line(index);
        let start = self.line_start(index);
        let Some(local) = image
            .range
            .start
            .checked_sub(start)
            .map(|from| from..image.range.end - start)
        else {
            return false;
        };
        local.end <= entry.text.len()
            && is_image(
                &entry.spans,
                &entry.text,
                &local,
                &image.destination,
                &image.alt,
            )
    }
}
