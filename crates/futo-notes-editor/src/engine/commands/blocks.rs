//! Heading, quote and divider commands.
use super::super::command::Command;
use super::super::Engine;
use crate::{BlockCommand, DisplayRange, EditorError, ParagraphKey};

impl Engine {
    /// Heading, quote and divider toolbar commands.
    pub(super) fn block_toggle(
        &self,
        _range: DisplayRange,
        _command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }

    /// Keys on heading and quote lines.
    pub(super) fn block_key(
        &self,
        _range: DisplayRange,
        _key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }
}
