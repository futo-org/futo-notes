//! Portable link operations: edits are ordinary input, inspection is a query.
use super::*;

impl PortableSession {
    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<crate::LinkDescription>, PortableError> {
        Ok(self.engine.inspect_link(expected, range)?)
    }

    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .set_link(expected, range, destination, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }

    /// Note ids never append; like a query they never wait on acknowledgements.
    pub fn update_note_ids(
        &mut self,
        note_ids: &[String],
    ) -> Result<crate::NoteIdChange, PortableError> {
        Ok(self.engine.update_note_ids(note_ids))
    }
}
