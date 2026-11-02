//! Completion requests are queries; acceptance is ordinary input.
use super::*;
use crate::WikilinkCompletion;

impl PortableSession {
    pub fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<WikilinkCompletion>, PortableError> {
        Ok(self.engine.wikilink_completion(expected)?)
    }

    pub fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
    ) -> Result<Applied, PortableError> {
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
        Ok(self.issue(record.unwrap(), change))
    }
}
