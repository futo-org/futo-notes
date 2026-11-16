//! Enter on list items.
use super::super::super::command::{Command, Edit};
use super::super::super::line::{Cut, Entry};
use super::super::super::Engine;
use super::super::marks::split;
use super::draft::{diff, Draft};
use super::number::{ordinal, spell, Level};
use super::{is_item, parts, Parts};
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
    /// From before the marker Enter is typing: a line break before it.
    pub(super) fn list_enter(&self, range: DisplayRange) -> Result<Option<Command>, EditorError> {
        let selected = self.source_selection(range);
        let first = self.line_of(selected.start);
        let last = self.line_of(selected.end);
        if first != last {
            if !is_item(&self.line(first).line) && !is_item(&self.line(last).line) {
                return Ok(None);
            }
            // A line break joining a fence's line to an item would open or
            // close code: Enter there changes nothing.
            let fenced = |index: usize| matches!(self.line(index).line.kind, Kind::Fence { .. });
            if fenced(first) || fenced(last) {
                return Ok(Some(Command::new(Vec::new(), first..last + 1, selected)));
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
        // Where the item's text shows: after its marker, before any marks it opens with.
        let text_start = self.display_of(start + part.content);
        if range.start.0 < text_start {
            return Ok(None);
        }
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
        let mut draft = Draft::new(self);
        let level = Level::of(&entry.line);
        // The number the item after this one takes.
        let next = number.map(|(n, delimiter)| {
            if draft.repeats(first, level, n, delimiter) {
                n
            } else {
                n + 1
            }
        });
        let ending = match entry.ending() {
            "" => self.empty_line_ending(first),
            ending => ending.to_owned(),
        };
        let (right, opens) = right_part(entry, selected.end - start);
        let at_start = range.start.0 == text_start;
        let (text, caret) = if at_start {
            // An empty item above; this one keeps its state and moves down.
            let above = item_prefix(body, &entry.line, &part, number.map(|(n, _)| n));
            let here = match next {
                Some(next) => numbered_prefix(body, &part, next),
                None => body[..part.content].to_owned(),
            };
            let caret = above.len() + ending.len() + here.len() + opens;
            (format!("{above}{ending}{here}{right}"), caret)
        } else {
            let left = left_part(entry, selected.start - start);
            let below = item_prefix(body, &entry.line, &part, next);
            let caret = left.len() + ending.len() + below.len() + opens;
            (format!("{left}{ending}{below}{right}"), caret)
        };
        if let (Some((n, delimiter)), Some(next)) = (number, next) {
            if next != n {
                draft.bump(first + 1, level, delimiter, n, next);
            }
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
        // The line keeps its hidden marker and its list marker unit; on a
        // line with no text (a blank line, a divider) the bytes after the
        // selection stay as typed.
        let hidden = match b.view.cuts.first() {
            Some((marker, Cut::Marker)) => marker.end,
            _ => 0,
        };
        let kept = b.marker_unit().map_or(hidden, |unit| unit.end).min(end);
        let (right, opens) = if b.line.content.is_empty() {
            (b.body()[end.max(kept)..].to_owned(), 0)
        } else {
            right_part(b, end)
        };
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
