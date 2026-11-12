//! Command families. Each family reads the lines a command is pointed at and
//! the selection, and returns a `Command` (text edits plus a new selection);
//! `Engine::run` applies it behind the one guard. A family that does not
//! claim a key leaves it to typing.
mod blocks;
mod clipboard;
mod fences;
pub(super) mod find;
mod images;
mod inline;
mod lists;
mod tables;
mod wikilinks;

use super::command::{Command, Edit};
use super::Engine;
use crate::{BlockCommand, CaretDirection, DisplayOffset, DisplayRange, EditorError, ParagraphKey};

impl Engine {
    /// The command a paragraph key runs on the lines it is pointed at, when
    /// a family claims the key there.
    pub(crate) fn key_command(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let families: [fn(
            &Self,
            DisplayRange,
            ParagraphKey,
        ) -> Result<Option<Command>, EditorError>; 4] = [
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
            | ParagraphKey::Delete => {
                let range = if range.start != range.end {
                    range
                } else {
                    let direction = if key == ParagraphKey::Delete {
                        CaretDirection::Forward
                    } else {
                        CaretDirection::Backward
                    };
                    let stop = self.grapheme_stop(range.start.0, direction);
                    DisplayRange {
                        start: DisplayOffset(range.start.0.min(stop)),
                        end: DisplayOffset(range.start.0.max(stop)),
                    }
                };
                if range.start == range.end || self.touches_metadata(range) {
                    return Ok(None);
                }
                (range, String::new())
            }
            ParagraphKey::Tab | ParagraphKey::ShiftTab => return Ok(None),
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
        Ok(Some(command))
    }

    /// A toolbar block command, by family.
    pub(crate) fn block_command(
        &self,
        range: DisplayRange,
        command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        match command {
            BlockCommand::Heading(_)
            | BlockCommand::ToggleHeading(_)
            | BlockCommand::Quote
            | BlockCommand::Divider => self.block_toggle(range, command),
            BlockCommand::Indent
            | BlockCommand::Outdent
            | BlockCommand::ToggleTask
            | BlockCommand::BulletList
            | BlockCommand::OrderedList
            | BlockCommand::TaskList => self.list_command(range, command),
            BlockCommand::CodeBlock | BlockCommand::WrapCodeBlock => {
                self.fence_command(range, command)
            }
        }
    }
}
