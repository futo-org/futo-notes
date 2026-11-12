//! List commands: Enter, Enter at an item's start, Enter on an empty item,
//! Backspace at an item's text start, Indent and Outdent (and their Tab
//! keys), the list toggles, the checkbox toggle, and renumbering.
//!
//! A list item is one line. A command edits the lines it is pointed at;
//! renumbering is the one exception, and names the lines it bumps
//! (`number.rs`). Indent and Outdent also move the lines under an item,
//! which they name.
mod draft;
mod enter;
mod indent;
mod number;
mod toggle;

use super::super::command::{kept_line, Command};
use super::super::Engine;
use crate::lines::block::TAB_WIDTH;
use crate::lines::{Carry, Kind, Line};
use crate::{BlockCommand, DisplayRange, EditorError, ParagraphKey};
use std::ops::Range;

impl Engine {
    /// Indent, outdent and the list toolbar commands.
    pub(super) fn list_command(
        &self,
        range: DisplayRange,
        command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        let range = self.outside_crlf(range);
        if self.touches_metadata(range) {
            return Ok(None);
        }
        match command {
            BlockCommand::Indent => self.indent_command(range, false),
            BlockCommand::Outdent => self.indent_command(range, true),
            BlockCommand::ToggleTask => self.toggle_task(range),
            BlockCommand::BulletList => self.toggle_list(range, toggle::Target::Bullet),
            BlockCommand::OrderedList => self.toggle_list(range, toggle::Target::Ordered),
            BlockCommand::TaskList => self.toggle_list(range, toggle::Target::Task),
            _ => Ok(None),
        }
    }

    /// Keys on list lines: Enter and Shift+Enter, Backspace at an item's
    /// text start, Tab and Shift+Tab. Delete joins as typing does.
    pub(super) fn list_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        let range = self.outside_crlf(range);
        if self.touches_metadata(range) {
            return Ok(None);
        }
        match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => self.list_enter(range),
            ParagraphKey::Backspace | ParagraphKey::BackspaceJoiningHeading => {
                self.list_backspace(range)
            }
            ParagraphKey::Tab | ParagraphKey::ShiftTab => {
                let touches_list = self
                    .lines_of(range)
                    .any(|index| matches!(self.line(index).line.kind, Kind::List { .. }));
                if !touches_list {
                    return Ok(None);
                }
                self.indent_command(range, key == ParagraphKey::ShiftTab)
            }
            ParagraphKey::Delete => Ok(None),
        }
    }

    /// The toolbar's `can_indent` and `can_outdent` for the caret's line:
    /// any list item can be indented; one with leading whitespace can be
    /// outdented.
    pub(crate) fn list_indents(&self) -> (bool, bool) {
        match self.caret_line().line.kind {
            Kind::List { indent, .. } => (true, indent > 0),
            _ => (false, false),
        }
    }
}

/// Where a line's prefix pieces end, line-relative: its quote markers, its
/// own leading whitespace, its list marker as typed, and its content.
#[derive(Clone, Debug)]
pub(super) struct Parts {
    pub quote: usize,
    /// End of the leading whitespace after the quote markers.
    pub space: usize,
    /// The list marker as typed (`-`, `3)`); empty for other lines.
    pub marker: Range<usize>,
    /// Where the line's text starts (after a task box). A blank line's is
    /// its end.
    pub content: usize,
}

/// The parts of `body` (a line without its ending) read as `line`.
pub(super) fn parts(body: &str, line: &Line) -> Parts {
    // Step back from `end` over `columns` of leading whitespace.
    let back = |end: usize, columns: usize| {
        let bytes = body.as_bytes();
        let (mut at, mut width) = (end, 0);
        while width < columns && at > 0 {
            at -= 1;
            width += if bytes[at] == b'\t' { TAB_WIDTH } else { 1 };
        }
        at
    };
    match &line.kind {
        Kind::List { indent, text, .. } => Parts {
            quote: back(text.start, *indent),
            space: text.start,
            marker: text.clone(),
            content: line.content.start,
        },
        Kind::Plain { indent } => Parts {
            quote: back(line.content.start, *indent),
            space: line.content.start,
            marker: line.content.start..line.content.start,
            content: line.content.start,
        },
        Kind::Heading { level } => {
            let quote = line.marker.end - *level as usize - 1;
            Parts {
                quote,
                space: quote,
                marker: quote..quote,
                content: line.content.start,
            }
        }
        Kind::Blank => Parts {
            quote: line.marker.end,
            space: body.len(),
            marker: body.len()..body.len(),
            content: body.len(),
        },
        Kind::Fence { .. } => {
            // Fences are never quoted; their leading whitespace (code's
            // included) is what Indent and Outdent move.
            let space = body.len() - body.trim_start_matches([' ', '\t']).len();
            Parts {
                quote: 0,
                space,
                marker: space..space,
                content: space,
            }
        }
        _ => Parts {
            quote: 0,
            space: 0,
            marker: 0..0,
            content: 0,
        },
    }
}

/// Whether `line` is a list item.
pub(super) fn is_item(line: &Line) -> bool {
    matches!(line.kind, Kind::List { .. })
}

/// Line `body` (read as `line` after `carry`) with its list marker and box
/// taken off: its quotes and indent stay, and a `\` is written when the
/// text would otherwise read as another block. An item with no text keeps
/// only its quotes. Also the length of the prefix written before the text
/// and where the text started.
pub(super) fn lifted(body: &str, line: &Line, carry: &Carry) -> (String, usize, usize) {
    let part = parts(body, line);
    let text = &body[part.content..];
    if text.trim_matches([' ', '\t']).is_empty() {
        return (body[..part.quote].to_owned(), part.quote, body.len());
    }
    let prefix = &body[..part.space];
    let plain = |read: &Line| matches!(read.kind, Kind::Plain { .. }) && read.quote == line.quote;
    (
        kept_line(carry, prefix, text, plain),
        prefix.len(),
        part.content,
    )
}
