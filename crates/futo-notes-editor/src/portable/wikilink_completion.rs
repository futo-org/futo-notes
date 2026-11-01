//! Completion requests are queries and wait for a released change; acceptance
//! uses the same ordered append/ack barrier as input.
use super::*;
use crate::WikilinkCompletion;

impl PortableSession {
    pub fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<WikilinkCompletion>, PortableError> {
        if self.pending.is_some() || self.bounded_entry.is_some() {
            return Err(PortableError::Busy);
        }
        Ok(self.engine.wikilink_completion(expected)?)
    }

    pub fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
    ) -> Result<HostRequest, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self.engine.accept_wikilink_completion(
            expected,
            range,
            query,
            note_id,
            &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            },
        )?;
        self.stage(record.unwrap(), change)
    }
}
