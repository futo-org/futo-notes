//! Portable plain Markdown clipboard. Cut and paste are ordinary input;
//! copying reads the page's draft, so a paused draft stays copyable.
use super::*;

impl PortableSession {
    pub fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, PortableError> {
        Ok(self.engine.copy_markdown(expected, range)?)
    }

    pub fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<(String, Option<Applied>), PortableError> {
        self.ready()?;
        let mut record = None;
        let (markdown, change) = self.engine.cut_markdown(expected, range, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        let applied = change.map(|change| self.issue(record.unwrap(), change));
        Ok((markdown, applied))
    }

    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .paste_markdown(expected, range, text, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }
}
