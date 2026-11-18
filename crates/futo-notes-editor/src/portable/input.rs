//! Input: block commands, paragraph keys and replacements. Each applies at
//! once and returns the request that sends its edit to the worker.
use super::*;

impl PortableSession {
    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: crate::BlockCommand,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| {
            engine.block_command_utf16(expected, range, command, accept)
        })
    }

    pub fn block_command_removing_utf16(
        &mut self,
        expected: Revision,
        removed: DisplayUtf16Range,
        command: crate::BlockCommand,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| {
            engine.block_command_removing_utf16(expected, removed, command, accept)
        })
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: crate::ParagraphKey,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.paragraph_key_utf16(expected, range, key, accept))
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.replace_action(expected, range, inserted, crate::InputAction::Typing)
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| {
            engine.replace_action(expected, range, inserted, action, accept)
        })
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayReplacement],
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.replace_many(expected, replacements, accept))
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let (range, inserted) = self.engine.decode_utf16_input(expected, range, inserted)?;
        self.replace(expected, range, &inserted)
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: crate::InputAction,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let (range, inserted) = self.engine.decode_utf16_input(expected, range, inserted)?;
        self.replace_action(expected, range, &inserted, action)
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayUtf16Replacement],
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let replacements = self
            .engine
            .decode_utf16_replacements(expected, replacements)?;
        self.replace_many(expected, &replacements)
    }
}
