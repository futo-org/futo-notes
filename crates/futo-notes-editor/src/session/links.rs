//! Destination-bearing editing commands share ordinary acceptance and history.
use super::*;

impl EditorSession {
    /// Inspect the contiguous run containing the complete selection. A caret at
    /// a run boundary follows the session's explicit neighbor affinity.
    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<crate::LinkDescription>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        Ok(self
            .projection
            .link_descriptions(range)
            .into_iter()
            .find(|link| {
                if range.start == range.end {
                    (link.range.start.0 < range.start.0 && range.start.0 < link.range.end.0)
                        || (range.start == link.range.start && self.affinity == Affinity::Forward)
                        || (range.start == link.range.end && self.affinity == Affinity::Backward)
                } else {
                    link.range.start.0 <= range.start.0 && range.end.0 <= link.range.end.0
                }
            }))
    }
}
