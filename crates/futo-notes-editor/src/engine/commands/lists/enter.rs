//! Enter and Backspace on list items.
use super::super::super::command::{Command, Edit};
use super::super::super::line::{Entry, Role};
use super::super::super::{store, Engine};
use super::super::marks::split;
use super::draft::{diff, Draft};
use super::number::{ordinal, spell, Level};
use super::{is_item, lifted, parts, Parts};
use crate::lines::Kind;
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
        Command::new(edits, first..last + 1, caret..caret)
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

/// The line's text before line offset `at`, with the marks that run across
/// `at` closed there (`marks::split`).
fn left_part(entry: &Entry, at: usize) -> String {
    let body = entry.body();
    let (at, closes, _) = split(body, &entry.line, &entry.spans, at.min(body.len()));
    format!("{}{closes}", &body[..at])
}

/// The line's text after line offset `at`, with the marks that run across
/// `at` opened again first; also where `at` is in it (after the marks
/// written first, and after marks that open at `at`).
fn right_part(entry: &Entry, at: usize) -> (String, usize) {
    let body = entry.body();
    let at = at.min(body.len());
    let (split_at, _, opens) = split(body, &entry.line, &entry.spans, at);
    let caret = opens.len() + at.saturating_sub(split_at);
    (format!("{opens}{}", &body[split_at..]), caret)
}
