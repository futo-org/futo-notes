//! The page owns the marked overlay; final source still waits for native append.
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
        self.ready()?;
        Ok(self.engine.cancel_composition(expected)?)
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .commit_composition_utf16(expected, text, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change =
            self.engine
                .replace_os_utf16(expected, range, text, placeholders, &mut |edit| {
                    record = Some(edit.clone());
                    Ok(())
                })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
}
