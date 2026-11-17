//! Portable header-tag edits are ordinary input: applied now, acknowledged later.
use super::*;

impl PortableSession {
    pub fn tags(&self) -> Result<Vec<String>, PortableError> {
        Ok(self.engine.tags())
    }

    pub fn header_tags(&self) -> Result<Vec<String>, PortableError> {
        Ok(self.engine.header_tags())
    }

    pub fn add_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.add_header_tag(expected, tag, accept))
    }

    pub fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.remove_header_tag(expected, tag, accept))
    }
}
