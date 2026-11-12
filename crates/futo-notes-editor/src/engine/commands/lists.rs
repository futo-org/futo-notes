//! List commands: Enter, Enter at an item's start, indent and outdent,
//! join and Backspace, the list toggles and renumbering.
use super::super::command::Command;
use super::super::Engine;
use crate::{BlockCommand, DisplayRange, EditorError, ParagraphKey};

impl Engine {
    /// Indent, outdent and the list toolbar commands.
    pub(super) fn list_command(
        &self,
        _range: DisplayRange,
        _command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }

    /// Keys on list lines.
    pub(super) fn list_key(
        &self,
        _range: DisplayRange,
        _key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }
}
