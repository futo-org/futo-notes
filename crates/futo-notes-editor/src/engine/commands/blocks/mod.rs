//! Heading, quote and divider commands, and the paragraph keys on heading
//! and quote lines. Each reads the lines it is pointed at and returns text
//! edits; `Engine::run` applies them behind the one guard.
//!
//! A heading or quote command rewrites the head of each line it changes (its
//! quote markers and block marker) and leaves the line's text alone, except
//! that `kept_line` writes a `\` where the text would otherwise read as
//! another block once its marker goes (`# - item` to Text is `\- item`).
mod divider;
mod keys;

use super::super::command::{kept_line, Command, Edit};
use super::super::line::Entry;
use super::super::Engine;
use crate::lines::{block, line_spans, Carry, Kind, Line, Span};
use crate::{BlockCommand, DisplayRange, EditorError, ParagraphKey};

impl Engine {
    /// Heading, quote and divider toolbar commands.
    pub(super) fn block_toggle(
        &self,
        range: DisplayRange,
        command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        Ok(match command {
            BlockCommand::Heading(level) if level <= 6 => self.heading(range, level),
            BlockCommand::ToggleHeading(level) if level <= 6 => {
                let lines = self.targets(range, false);
                let common = self.common_heading(&lines);
                self.heading(
                    range,
                    if level > 0 && common == Some(level) {
                        0
                    } else {
                        level
                    },
                )
            }
            BlockCommand::Quote => self.quote(range),
            BlockCommand::Divider => self.divider(range),
            _ => None,
        })
    }

    /// Keys on heading and quote lines.
    pub(super) fn block_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        Ok(match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => self.block_enter(range),
            ParagraphKey::Backspace => self.block_backspace(range, false),
            ParagraphKey::BackspaceJoiningHeading => self.block_backspace(range, true),
            ParagraphKey::Delete | ParagraphKey::Tab | ParagraphKey::ShiftTab => None,
        })
    }

    /// The toolbar's heading for the selection: the level every touched line
    /// shares (0 for text), as the heading toggle decides it.
    pub(crate) fn toolbar_heading(&self) -> Option<u8> {
        self.common_heading(&self.targets(self.selection, false))
    }

    /// The toolbar's quote for the selection: whether Quote takes a level off.
    pub(crate) fn toolbar_quote(&self) -> bool {
        self.all_quoted(&self.targets(self.selection, true))
    }

    /// The lines `range` touches that a heading command (`quote` false) or
    /// the quote command changes. Fences, front matter and dividers are never
    /// changed; table lines take a quote but no heading.
    fn targets(&self, range: DisplayRange, quote: bool) -> Vec<usize> {
        self.lines_of(range)
            .filter(|&index| match self.line(index).line.kind {
                Kind::Plain { .. } | Kind::Blank | Kind::Heading { .. } | Kind::List { .. } => true,
                Kind::Table { .. } => quote,
                _ => false,
            })
            .collect()
    }

    /// The lines that decide a command's direction: the lines with text,
    /// or every line when all are blank.
    fn content(&self, lines: &[usize]) -> Vec<usize> {
        let content: Vec<usize> = lines
            .iter()
            .copied()
            .filter(|&index| self.line(index).line.kind != Kind::Blank)
            .collect();
        if content.is_empty() {
            lines.to_vec()
        } else {
            content
        }
    }

    fn common_heading(&self, lines: &[usize]) -> Option<u8> {
        let level = |index: usize| match self.line(index).line.kind {
            Kind::Heading { level } => level,
            _ => 0,
        };
        let mut levels = self.content(lines).into_iter().map(level);
        let first = levels.next()?;
        levels.all(|level| level == first).then_some(first)
    }

    fn all_quoted(&self, lines: &[usize]) -> bool {
        let content = self.content(lines);
        !content.is_empty() && content.iter().all(|&i| self.line(i).line.quote > 0)
    }

    /// Heading `level` (0: text) on every touched line with text; blank
    /// lines take it only when every touched line is blank.
    fn heading(&self, range: DisplayRange, level: u8) -> Option<Command> {
        let lines = self.content(&self.targets(range, false));
        let changes = lines
            .into_iter()
            .filter_map(|index| Some((index, as_heading(self.line(index), level)?)))
            .collect();
        self.retext(range, changes)
    }

    /// Quote: when every touched line with text is quoted, one level off
    /// each quoted line, each keeping its block. Otherwise one level on each
    /// line from the first with text to the last (blank lines between them
    /// too); a heading or list item becomes quoted text.
    fn quote(&self, range: DisplayRange) -> Option<Command> {
        let lines = self.targets(range, true);
        let changes = if self.all_quoted(&lines) {
            lines
                .into_iter()
                .filter(|&index| self.line(index).line.quote > 0)
                .map(|index| (index, unquoted(self.line(index))))
                .collect()
        } else {
            let content = self.content(&lines);
            let (&first, &last) = (content.first()?, content.last()?);
            lines
                .into_iter()
                .filter(|&index| (first..=last).contains(&index))
                .map(|index| (index, quoted(self.line(index))))
                .collect()
        };
        self.retext(range, changes)
    }

    /// A command giving each of `changes` (line, text without its ending)
    /// its new text, editing only the bytes that differ. The selection
    /// follows its text.
    fn retext(&self, range: DisplayRange, changes: Vec<(usize, String)>) -> Option<Command> {
        let mut edits = Vec::new();
        let mut lines = Vec::new();
        for (index, text) in changes {
            let edit = least(self.line_start(index), self.line(index).body(), &text);
            if !edit.range.is_empty() || !edit.text.is_empty() {
                edits.push(edit);
                lines.push(index..index + 1);
            }
        }
        if edits.is_empty() {
            return None;
        }
        let selection = self.source_selection(range);
        let mut command = Command::new(edits, 0..1, 0..0);
        command.lines = lines;
        command.selection = mapped(&command, selection.start)..mapped(&command, selection.end);
        Some(command)
    }

    /// The line a key or the divider acts on, as it reads once the
    /// selection is removed: the touched lines joined into one.
    fn joined(&self, range: DisplayRange) -> Option<Joined> {
        let selection = self.source_selection(range);
        if range.start == range.end {
            let first = self.line_of(selection.start);
            let entry = self.line(first);
            let caret = selection.start - self.line_start(first);
            return (caret <= entry.body_len()).then(|| Joined {
                first,
                last: first,
                text: entry.body().to_owned(),
                caret,
                carry: entry.carry.clone(),
                line: entry.line.clone(),
                spans: entry.spans.clone(),
            });
        }
        let plan = self.plan(range, "");
        let (first, last) = (self.line_of(plan.range.start), self.line_of(plan.range.end));
        let start = self.line_start(first);
        let end = self.line_start(last) + self.line(last).body_len();
        if plan.range.end > end {
            return None;
        }
        let mut text = self.source_slice(start..plan.range.start);
        text.push_str(&plan.inserted);
        text.push_str(&self.source_slice(plan.range.end..end));
        let carry = self.line(first).carry.clone();
        let line = block::read_line(&mut carry.clone(), &text, 0);
        let spans = line_spans(&text, &line);
        Some(Joined {
            first,
            last,
            caret: plan.caret - start,
            text,
            carry,
            line,
            spans,
        })
    }

    /// A command replacing the joined lines with `text`, the caret at
    /// `caret` in it.
    fn rejoin(&self, joined: &Joined, text: &str, caret: usize) -> Command {
        let start = self.line_start(joined.first);
        let end = self.line_start(joined.last) + self.line(joined.last).body_len();
        let old = self.source_slice(start..end);
        let at = start + caret;
        Command::new(
            vec![least(start, &old, text)],
            joined.first..joined.last + 1,
            at..at,
        )
    }
}

/// Where source offset `at` lands after `command`'s edits: after text an
/// edit inserts at it, but never between a `\` an edit wrote and the
/// character it escapes.
fn mapped(command: &Command, at: usize) -> usize {
    let landed = command.map(at, true);
    let escaped = command
        .edits
        .iter()
        .any(|edit| edit.text.ends_with('\\') && command.map(edit.range.end, true) == landed);
    landed - usize::from(escaped)
}

/// The touched lines of a key or the divider, joined into one line.
struct Joined {
    first: usize,
    last: usize,
    /// The joined line's text, without an ending.
    text: String,
    /// The caret, as an offset into `text`.
    caret: usize,
    /// The carry before the first line.
    carry: Carry,
    /// The reading of `text`, offsets into it.
    line: Line,
    spans: Vec<Span>,
}

impl Joined {
    /// The quote markers the line starts with, as typed.
    fn quote(&self) -> &str {
        &self.text[..quote_end(&self.text, self.line.quote)]
    }
}

/// Bytes of the `depth` quote markers at the start of `text` (each `>` and
/// one space or tab after it), as the reader counted them.
fn quote_end(text: &str, depth: usize) -> usize {
    let bytes = text.as_bytes();
    let mut at = 0;
    for _ in 0..depth {
        at += 1;
        if matches!(bytes.get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    }
    at
}

/// Quote markers to write a marker or text after: a prefix ending in `>`
/// gains a space so it does not run into what follows (`>` alone is an
/// empty quote line).
fn spaced(quote: &str) -> String {
    let mut out = quote.to_owned();
    if !out.is_empty() && !out.ends_with([' ', '\t']) {
        out.push(' ');
    }
    out
}

/// A plain or blank line at quote `depth`.
fn plain(line: &Line, depth: usize) -> bool {
    matches!(line.kind, Kind::Plain { .. } | Kind::Blank) && line.quote == depth
}

/// The edit turning `old` (at source `start`) into `new`, without the bytes
/// they share at either end.
fn least(start: usize, old: &str, new: &str) -> Edit {
    let mut head = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(head) {
        head -= 1;
    }
    let room = old.len().min(new.len()) - head;
    let mut tail = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - tail) {
        tail -= 1;
    }
    Edit::new(
        start + head..start + old.len() - tail,
        &new[head..new.len() - tail],
    )
}

/// A line's text as heading `level` (0: plain text), keeping its quote
/// markers; `None` when it already is one, or is not a line a heading
/// command changes. A list item loses its marker.
fn as_heading(entry: &Entry, level: u8) -> Option<String> {
    let line = &entry.line;
    let body = entry.body();
    let quote = &body[..quote_end(body, line.quote)];
    let text = match line.kind {
        Kind::Heading { level: was } if was == level => return None,
        Kind::Plain { .. } | Kind::Blank if level == 0 => return None,
        Kind::Heading { .. } | Kind::List { .. } | Kind::Plain { .. } => {
            &body[line.content.start..]
        }
        Kind::Blank => "",
        _ => return None,
    };
    if level == 0 {
        let depth = line.quote;
        return Some(kept_line(&entry.carry, quote, text, |read| {
            plain(read, depth)
        }));
    }
    Some(format!(
        "{}{} {text}",
        spaced(quote),
        "#".repeat(usize::from(level))
    ))
}

/// A line with one more quote level. A heading or list item becomes quoted
/// text; any other line keeps its text as it is.
fn quoted(entry: &Entry) -> String {
    let line = &entry.line;
    let body = entry.body();
    let depth = line.quote + 1;
    let keeps = |read: &Line| plain(read, depth);
    match line.kind {
        Kind::Heading { .. } | Kind::List { .. } => {
            let quote = &body[..quote_end(body, line.quote)];
            let text = &body[line.content.start..];
            kept_line(&entry.carry, &format!("> {quote}"), text, keeps)
        }
        _ => kept_line(&entry.carry, "> ", body, keeps),
    }
}

/// A quoted line with one quote level fewer, keeping its block: the first
/// `>` goes, with one space or tab after it.
fn unquoted(entry: &Entry) -> String {
    unquote(&entry.carry, entry.body(), &entry.line)
}

fn unquote(carry: &Carry, body: &str, line: &Line) -> String {
    let mut rest = &body[1..];
    if rest.starts_with([' ', '\t']) {
        rest = &rest[1..];
    }
    let depth = line.quote - 1;
    let quote = quote_end(rest, depth);
    let keeps = |read: &Line| {
        read.quote == depth
            && match (&line.kind, &read.kind) {
                (Kind::Heading { level }, Kind::Heading { level: now }) => level == now,
                (Kind::List { .. }, Kind::List { .. }) => true,
                (Kind::Plain { .. } | Kind::Blank, _) => plain(read, depth),
                _ => false,
            }
    };
    kept_line(carry, &rest[..quote], &rest[quote..], keeps)
}

/// Where a line splits for a caret at `at`, and the marks the split closes
/// on the left and opens again on the right. A caret at a mark's text start
/// splits before the mark, at its text end after it, so a mark is only
/// closed and opened again when the caret is inside its text.
fn split(text: &str, line: &Line, spans: &[Span], at: usize) -> (usize, String, String) {
    let marks: Vec<&Span> = spans
        .iter()
        .filter(|span| !span.open.is_empty() && !span.close.is_empty())
        .collect();
    let mut at = at.max(line.content.start);
    for _ in 0..=marks.len() * 2 {
        let out = marks.iter().find_map(|span| {
            if span.open.end == at && span.open.start < at {
                Some(span.open.start)
            } else if span.close.start == at && span.close.end > at {
                Some(span.close.end)
            } else {
                None
            }
        });
        match out {
            Some(moved) => at = moved,
            None => break,
        }
    }
    let mut inside: Vec<&Span> = marks
        .into_iter()
        .filter(|span| span.open.end < at && at < span.close.start)
        .collect();
    inside.sort_by_key(|span| span.open.start);
    let opens: String = inside.iter().map(|span| &text[span.open.clone()]).collect();
    let closes: String = inside
        .iter()
        .rev()
        .map(|span| &text[span.close.clone()])
        .collect();
    (at, closes, opens)
}

/// The right side of a split line: plain text at the line's quote depth,
/// `opens` then `rest`, and where `rest` starts in it (before any `\`
/// written to keep it plain).
fn right_side(
    carry: &Carry,
    quote: &str,
    depth: usize,
    opens: &str,
    rest: &str,
) -> (String, usize) {
    let prefix = if depth > 0 {
        spaced(quote)
    } else {
        String::new()
    };
    let line = kept_line(carry, &prefix, &format!("{opens}{rest}"), |read| {
        plain(read, depth)
    });
    (line, prefix.len() + opens.len())
}
