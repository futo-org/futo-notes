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
        self.ready()?;
        let mut record = None;
        let change = self.engine.add_header_tag(expected, tag, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }

    pub fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self.engine.remove_header_tag(expected, tag, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }
}
