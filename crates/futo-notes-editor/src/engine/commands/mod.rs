//! Command families. Each family reads the lines a command is pointed at and
//! the selection, and returns a `Command` (text edits plus a new selection);
//! `Engine::run` applies it behind the one guard. A family that does not
//! claim a key leaves it to typing.
mod allowed;
mod atoms;
mod blocks;
mod clipboard;
mod fences;
pub(super) mod find;
mod images;
mod inline;
mod lists;
mod marks;
pub(super) mod moves;
mod paired_typing;
pub(super) mod tables;
mod transpose;
mod wikilinks;

pub(crate) use lists::Shift;

use super::command::{Command, Edit};
use super::Engine;
use crate::{BlockCommand, CaretDirection, DisplayRange, EditorError, ParagraphKey};
pub use paired_typing::is_paired_typing_key;

/// A family's claim on a paragraph key: the command it runs, if it claims it.
type KeyFamily = fn(&Engine, DisplayRange, ParagraphKey) -> Result<Option<Command>, EditorError>;

impl Engine {
    /// The command a paragraph key runs on the lines it is pointed at, when
    /// a family claims the key there; a range is first taken out of front
    /// matter (`in_body`), images and wikilinks (`outside_atoms`), as for
    /// every plan. None claims a range holding part of the front matter.
    pub(crate) fn key_command(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        if self.touches_metadata(range) {
            return Ok(None);
        }
        let range = self.outside_atoms(self.in_body(range));
        let families: [KeyFamily; 5] = [
            Self::atom_key,
            Self::table_key,
            Self::fence_key,
            Self::list_key,
            Self::block_key,
        ];
        for family in families {
            if let Some(command) = family(self, range, key)? {
                return Ok(Some(command));
            }
        }
        Ok(None)
    }

    /// A key's plain text edit, as a command that always lands: Enter writes
    /// the line's own line break, Backspace and Delete remove the range or
    /// one visible grapheme. Used when a key arrives over marked text.
    /// Transpose is the one exception: its swap goes behind the guard
    /// (`transpose.rs`).
    pub(crate) fn typed_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let (range, text) = match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => {
                let (index, _) = self.line_at_display(super::store::display, range.start.0);
                (range, self.empty_line_ending(index))
            }
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::PairedBackspace
            | ParagraphKey::Delete => {
                let range = if range.start != range.end {
                    range
                } else {
                    let direction = if key == ParagraphKey::Delete {
                        CaretDirection::Forward
                    } else {
                        CaretDirection::Backward
                    };
                    self.caret_deletion(range.start.0, direction)
                };
                if range.start == range.end || self.touches_metadata(range) {
                    return Ok(None);
                }
                (range, String::new())
            }
            ParagraphKey::Tab | ParagraphKey::ShiftTab => return Ok(None),
            ParagraphKey::Transpose => return self.transpose_command(range),
        };
        let plan = self.plan(self.outside_crlf(range), &text);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let mut command = Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first..last + 1,
            plan.caret..plan.caret,
        );
        command.typed = true;
        command.carry = self.deleted_formats(range, &text);
        Ok(Some(command))
    }

    /// A toolbar block command, by family, on the range's body part
    /// (`in_body`).
    pub(crate) fn block_command(
        &self,
        range: DisplayRange,
        command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let range = self.in_body(range);
        match command {
            BlockCommand::Heading(_)
            | BlockCommand::ToggleHeading(_)
            | BlockCommand::Quote
            | BlockCommand::Divider
            | BlockCommand::Table { .. } => self.block_toggle(range, command),
            BlockCommand::Indent | BlockCommand::Outdent => {
                match self.fence_indent(range, command == BlockCommand::Outdent)? {
                    Some(command) => Ok(Some(command)),
                    None => self.list_command(range, command),
                }
            }
            BlockCommand::ToggleTask
            | BlockCommand::BulletList
            | BlockCommand::OrderedList
            | BlockCommand::TaskList => self.list_command(range, command),
            BlockCommand::CodeBlock | BlockCommand::WrapCodeBlock => {
                self.fence_command(range, command)
            }
            BlockCommand::OpenLineBeforeCodeBlock => Ok(self.open_line_beside_block(range, false)),
            BlockCommand::OpenLineAfterCodeBlock => Ok(self.open_line_beside_block(range, true)),
            BlockCommand::OpenCodeLineBelow => Ok(self.open_code_line(range, true)),
            BlockCommand::OpenCodeLineAbove => Ok(self.open_code_line(range, false)),
        }
    }
}
