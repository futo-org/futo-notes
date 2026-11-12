//! Fenced code: the code block commands and keys inside a fence.
use super::super::command::Command;
use super::super::Engine;
use crate::{BlockCommand, DisplayRange, EditorError, ParagraphKey};

impl Engine {
    /// Code block toolbar commands.
    pub(super) fn fence_command(
        &self,
        _range: DisplayRange,
        _command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }

    /// Keys inside a fence.
    pub(super) fn fence_key(
        &self,
        _range: DisplayRange,
        _key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }
}
