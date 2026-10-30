//! Portable link operations use the same ordered append/ack barrier as input.
use super::*;

impl PortableSession {
    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<crate::LinkDescription>, PortableError> {
        self.ready()?;
        Ok(self.engine.inspect_link(expected, range)?)
    }

    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .set_link(expected, range, destination, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
}
