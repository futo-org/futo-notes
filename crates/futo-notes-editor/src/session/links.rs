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

impl EditorSession {
    /// Set the selected link destination, expanding an interior selection to
    /// that complete contiguous run. Empty destinations unlink. An unchanged
    /// destination accepts no record and adds no history.
    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if destination.contains(['\r', '\n', '\0']) {
            return Err(EditorError::InvalidText);
        }
        if self.composition().is_some() {
            return self.command_during_composition(
                expected,
                range,
                accept,
                |staged, local, accept| {
                    staged.set_link(staged.revision(), local, destination, accept)
                },
            );
        }
        self.validate_range(range)?;
        let link = self.inspect_link(expected, range)?;
        if link
            .as_ref()
            .is_some_and(|link| link.destination == destination)
            || link.is_none() && destination.is_empty()
        {
            return Ok(None);
        }
        let target = link.map_or(range, |link| link.range);
        if target.start == target.end {
            return Ok(None);
        }
        if self
            .projection
            .block_lines(target)
            .iter()
            .any(|line| line.code)
        {
            return Ok(None);
        }
        let plan = self
            .projection
            .link_edit(&self.source, target, destination)?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let before_links = self.projection.literal_links.clone();
        let mut change = self.apply(&edit);
        self.selection = range;
        self.pending_formats = None;
        change.selection = range;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        self.record_input_history(
            HistoryEntry {
                before_selection,
                before_affinity,
                before_formats,
                before_links,
                after_selection: range,
                after_affinity: self.affinity,
                after_formats: None,
                after_links: self.projection.literal_links.clone(),
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            },
            None,
        );
        Ok(Some(change))
    }
}
