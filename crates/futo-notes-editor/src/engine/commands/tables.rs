//! Tables: inspection, table keys and table commands.
use super::super::command::Command;
use super::super::Engine;
use crate::{DisplayRange, EditorError, ParagraphKey};

impl Engine {
    /// Paragraph keys inside a table.
    pub(super) fn table_key(
        &self,
        _range: DisplayRange,
        _key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        Ok(None)
    }
}
