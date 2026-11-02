//! Editor input: every edit applies in memory; saving is scheduled separately.
use super::*;

impl Attachment {
    /// Called only while the attachment lock is held.
    pub(super) fn input_ready(&self) -> Result<(), EditorStoreError> {
        if self.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        Ok(())
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.toggle_format(expected, format, accept))
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.undo(expected, accept))
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.redo(expected, accept))
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: futo_notes_editor::BlockCommand,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.block_command_utf16(expected, range, command, accept))
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: futo_notes_editor::ParagraphKey,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.paragraph_key_utf16(expected, range, key, accept))
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        let (range, inserted) = self
            .engine
            .decode_utf16_input(expected, range, inserted)
            .map_err(EditorStoreError::Editor)?;
        self.replace(expected, range, &inserted)
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        let (range, inserted) = self
            .engine
            .decode_utf16_input(expected, range, inserted)
            .map_err(EditorStoreError::Editor)?;
        self.replace_action(expected, range, &inserted, action)
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayUtf16Replacement],
    ) -> Result<ViewChange, EditorStoreError> {
        let replacements = self
            .engine
            .decode_utf16_replacements(expected, replacements)
            .map_err(EditorStoreError::Editor)?;
        self.replace_many(expected, &replacements)
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        self.replace_action(
            expected,
            range,
            inserted,
            futo_notes_editor::InputAction::Typing,
        )
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.edit(|engine, accept| engine.replace_action(expected, range, inserted, action, accept))
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayReplacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.edit(|engine, accept| engine.replace_many(expected, replacements, accept))
    }
}
