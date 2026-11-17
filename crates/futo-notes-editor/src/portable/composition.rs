//! The page owns the marked overlay; committing it is ordinary input.
use super::*;

impl PortableSession {
    pub fn composition(&self) -> Option<&crate::Composition> {
        self.engine.composition()
    }

    pub fn compose_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
    ) -> Result<crate::Composition, PortableError> {
        self.ready()?;
        Ok(self.engine.compose_utf16(expected, range, text)?)
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), PortableError> {
        Ok(self.engine.cancel_composition(expected)?)
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.commit_composition_utf16(expected, text, accept))
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| {
            engine.replace_os_utf16(expected, range, text, placeholders, accept)
        })
    }
}
