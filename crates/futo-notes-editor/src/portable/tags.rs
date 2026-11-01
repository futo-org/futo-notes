//! Portable header-tag edits use the same ordered append/ack barrier as input.
use super::*;

impl PortableSession {
    pub fn tags(&self) -> Result<Vec<String>, PortableError> {
        self.ready()?;
        Ok(self.engine.tags())
    }

    pub fn header_tags(&self) -> Result<Vec<String>, PortableError> {
        self.ready()?;
        Ok(self.engine.header_tags())
    }

    pub fn add_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self.engine.add_header_tag(expected, tag, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    pub fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self.engine.remove_header_tag(expected, tag, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
}
