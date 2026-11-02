//! Portable plain Markdown clipboard. Cut and paste use the same ordered
//! append/ack barrier as input; copying reads the accepted projection, so a
//! paused draft stays copyable while a pending change reports Busy.
use super::*;

impl PortableSession {
    pub fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, PortableError> {
        if self.pending.is_some() {
            return Err(PortableError::Busy);
        }
        Ok(self.engine.copy_markdown(expected, range)?)
    }

    pub fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<(String, Option<HostRequest>), PortableError> {
        self.ready()?;
        let mut record = None;
        let (markdown, change) = self.engine.cut_markdown(expected, range, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        let request = change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()?;
        Ok((markdown, request))
    }

    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .paste_markdown(expected, range, text, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
}
