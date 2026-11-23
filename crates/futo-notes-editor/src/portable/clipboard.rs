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
        let ((markdown, change), record) =
            self.record_edit(|engine, accept| engine.cut_markdown(expected, range, accept))?;
        Ok((markdown, self.issue_accepted(record, change)))
    }

    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.paste_markdown(expected, range, text, accept))
    }

    /// Drag-to-move (`EditorSession::move_markdown`): each change an edit for
    /// the host, in the order they landed.
    pub fn move_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        to: crate::DisplayOffset,
    ) -> Result<Vec<Applied>, PortableError> {
        self.ready()?;
        let mut records = Vec::new();
        let changes = self
            .engine
            .move_markdown(expected, range, to, &mut |edit| {
                records.push(edit.clone());
                Ok(())
            })?;
        Ok(records
            .into_iter()
            .zip(changes)
            .map(|(edit, change)| self.issue(edit, change))
            .collect())
    }
}
