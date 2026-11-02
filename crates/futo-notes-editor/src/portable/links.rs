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

    /// Note ids never append. Like a query, they wait for a released change so
    /// returned semantics address the page's displayed revision.
    pub fn update_note_ids(
        &mut self,
        note_ids: &[String],
    ) -> Result<crate::NoteIdChange, PortableError> {
        if self.pending.is_some() {
            return Err(PortableError::Busy);
        }
        Ok(self.engine.update_note_ids(note_ids))
    }
}
