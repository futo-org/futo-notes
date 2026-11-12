//! Enter and Backspace on list items.
use super::super::super::command::{Command, Edit};
use super::super::super::line::{Entry, Role};
use super::super::super::{store, Engine};
use super::draft::{diff, Draft};
use super::number::{ordinal, spell, Level};
use super::{is_item, lifted, parts, Parts};
use crate::lines::{Kind, Span, SpanKind};
use crate::{DisplayRange, EditorError};
use std::ops::Range;

impl Engine {
    /// Enter (and Shift+Enter) on a list item. With the caret in the item's
    /// text it splits the item: the new item below takes the text after
    /// the caret, the next number and an unchecked box. At the text's start
    /// it opens an empty item above. On an empty item it outdents an
    /// indented item, else takes the marker off. A selection's text goes
    /// first; one spanning lines leaves the line it ends on its own block.
    pub(super) fn list_enter(&self, range: DisplayRange) -> Result<Option<Command>, EditorError> {
        let selected = self.source_selection(range);
        let first = self.line_of(selected.start);
        let last = self.line_of(selected.end);
        if first != last {
            if !is_item(&self.line(first).line) && !is_item(&self.line(last).line) {
                return Ok(None);
            }
            return Ok(Some(self.enter_across(selected, first, last)));
        }
        let entry = self.line(first);
        if !is_item(&entry.line) {
            return Ok(None);
        }
        let body = entry.body();
        let part = parts(body, &entry.line);
        let start = self.line_start(first);
        let empty = body[part.content..].trim_matches([' ', '\t']).is_empty();
        if range.start == range.end && empty {
            if matches!(entry.line.kind, Kind::List { indent, .. } if indent > 0) {
                return self.indent_command(range, true);
            }
            // Out of the list: the marker goes, an enclosing quote stays.
            let quote = &body[..part.quote];
            let caret = start + quote.len();
            return Ok(diff(start, body, quote)
                .map(|edit| Command::new(vec![edit], first..first + 1, caret..caret)));
        }
        let number = ordinal(body, &entry.line);
        let ending = match entry.ending() {
            "" => self.empty_line_ending(first),
            ending => ending.to_owned(),
        };
        let (right, opens) = right_part(entry, selected.end - start);
        let at_start = range.start.0 == self.store.before(first).display;
        let (text, caret) = if at_start {
            // An empty item above; this one keeps its state and moves down.
            let above = item_prefix(body, &entry.line, &part, number.map(|(n, _)| n));
            let here = match number {
                Some((n, _)) => numbered_prefix(body, &part, n + 1),
                None => body[..part.content].to_owned(),
            };
            let caret = above.len() + ending.len() + here.len() + opens;
            (format!("{above}{ending}{here}{right}"), caret)
        } else {
            let left = left_part(entry, selected.start - start);
            let next = item_prefix(body, &entry.line, &part, number.map(|(n, _)| n + 1));
            let caret = left.len() + ending.len() + next.len() + opens;
            (format!("{left}{ending}{next}{right}"), caret)
        };
        let mut draft = Draft::new(self);
        if let Some((n, delimiter)) = number {
            draft.bump(first + 1, Level::of(&entry.line), delimiter, n, n + 1);
        }
        let main = diff(start, body, &text).map(|edit| (edit, first..first + 1));
        Ok(draft.finish(main, start + caret..start + caret))
    }

    /// Enter over a selection from line `first` to line `last`: the text
    /// between goes, a line break takes its place, and the line the
    /// selection ends on keeps its own marker and block. When that changes
    /// nothing the key still belongs to the list: a command with no edits.
    fn enter_across(&self, selected: Range<usize>, first: usize, last: usize) -> Command {
        let (a, b) = (self.line(first), self.line(last));
        let start = self.line_start(first);
        let b_start = self.line_start(last);
        let left = left_part(a, selected.start - start);
        let end = selected.end - b_start;
        let kept = parts(b.body(), &b.line).content.min(end);
        let (right, opens) = right_part(b, end);
        let text = format!("{left}{}{}{right}", a.ending(), &b.body()[..kept]);
        let old = self.source_slice(start..b_start + b.body_len());
        let caret = start + left.len() + a.ending().len() + kept + opens;
        let edits: Vec<Edit> = diff(start, &old, &text).into_iter().collect();
        // A command with no edits sets the selection (`surface.rs` `key`):
        // when nothing changes, the selection stays.
        let selection = if edits.is_empty() {
            selected
        } else {
            caret..caret
        };
        Command::new(edits, first..last + 1, selection)
    }

    /// Backspace with the caret at a list item's text start takes the
    /// marker (and task box) off: the line stays, as plain text at its own
    /// indent inside its quotes. An emptied item becomes an empty line.
    pub(super) fn list_backspace(
        &self,
        range: DisplayRange,
    ) -> Result<Option<Command>, EditorError> {
        if range.start != range.end {
            return Ok(None);
        }
        let (index, before) = self.line_at_display(store::display, range.start.0);
        let entry = self.line(index);
        if !is_item(&entry.line) || before.display != range.start.0 || entry.view.role != Role::Text
        {
            return Ok(None);
        }
        let (written, prefix, _) = lifted(entry.body(), &entry.line, &entry.carry);
        let start = self.line_start(index);
        let caret = start + prefix;
        Ok(diff(start, entry.body(), &written)
            .map(|edit| Command::new(vec![edit], index..index + 1, caret..caret)))
    }
}

/// The prefix of a new item like the one on `body`: its quotes and indent,
/// its marker (with `number` when it is numbered), the space after it, and
/// an unchecked box when it is a task.
fn item_prefix(
    body: &str,
    line: &crate::lines::Line,
    part: &Parts,
    number: Option<i128>,
) -> String {
    let marker = &body[part.marker.clone()];
    let marker = match number {
        Some(n) => format!(
            "{}{}",
            spell(n, &marker[..marker.len() - 1]),
            &marker[marker.len() - 1..]
        ),
        None => marker.to_owned(),
    };
    let gap = &body[part.marker.end..part.marker.end + 1];
    let task = if matches!(line.kind, Kind::List { task: Some(_), .. }) {
        "[ ] "
    } else {
        ""
    };
    format!("{}{marker}{gap}{task}", &body[..part.marker.start])
}

/// `body`'s prefix with its number written as `number`.
fn numbered_prefix(body: &str, part: &Parts, number: i128) -> String {
    let digits = &body[part.marker.start..part.marker.end - 1];
    format!(
        "{}{}{}",
        &body[..part.marker.start],
        spell(number, digits),
        &body[part.marker.end - 1..part.content]
    )
}

/// Marks that close at a line break and open again on the next line when
/// Enter splits their text.
fn splits(span: &Span) -> bool {
    matches!(
        span.kind,
        SpanKind::Bold
            | SpanKind::Italic
            | SpanKind::Strike
            | SpanKind::Code
            | SpanKind::Link { .. }
    ) && !span.open.is_empty()
        && !span.close.is_empty()
}

/// The marks of `entry` whose text runs across line offset `at`.
fn across(entry: &Entry, at: usize) -> Vec<&Span> {
    let mut spans: Vec<&Span> = entry
        .spans
        .iter()
        .filter(|span| splits(span) && span.open.end <= at && at <= span.close.start)
        .collect();
    spans.sort_by_key(|span| span.open.start);
    spans
}

/// `body` without the `cuts` (sorted, inside `from..to`), from `from` to `to`.
fn without(body: &str, from: usize, to: usize, cuts: &[Range<usize>]) -> String {
    let mut out = String::with_capacity(to - from);
    let mut at = from;
    for cut in cuts {
        out.push_str(&body[at..cut.start]);
        at = cut.end;
    }
    out.push_str(&body[at..to]);
    out
}

/// The line's text before line offset `at`, with the marks that run across
/// `at` closed there; a mark with no text before `at` loses its opening.
fn left_part(entry: &Entry, at: usize) -> String {
    let body = entry.body();
    let spans = across(entry, at);
    let cuts: Vec<Range<usize>> = spans
        .iter()
        .filter(|span| span.open.end == at)
        .map(|span| span.open.clone())
        .collect();
    let mut out = without(body, 0, at, &cuts);
    for span in spans.iter().rev().filter(|span| span.open.end < at) {
        out.push_str(&body[span.close.clone()]);
    }
    out
}

/// The line's text after line offset `at`, with the marks that run across
/// `at` opened again first; a mark with no text after `at` loses its
/// closing. Also the length of the marks written first.
fn right_part(entry: &Entry, at: usize) -> (String, usize) {
    let body = entry.body();
    let at = at.min(body.len());
    let spans = across(entry, at);
    let mut out = String::new();
    for span in spans.iter().filter(|span| span.close.start > at) {
        out.push_str(&body[span.open.clone()]);
    }
    let opens = out.len();
    let mut cuts: Vec<Range<usize>> = spans
        .iter()
        .filter(|span| span.close.start == at)
        .map(|span| span.close.clone())
        .collect();
    cuts.sort_by_key(|cut| cut.start);
    out.push_str(&without(body, at, body.len(), &cuts));
    (out, opens)
}
