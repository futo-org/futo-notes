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
        self.inspect_link_with_work(expected, range)
            .map(|(link, _)| link)
    }

    fn inspect_link_with_work(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<
        (
            Option<crate::LinkDescription>,
            crate::inline::references::ReferenceWork,
        ),
        EditorError,
    > {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let (links, work) = self.projection.link_descriptions_with_work(range);
        Ok((
            links.into_iter().find(|link| {
                if range.start == range.end {
                    (link.range.start.0 < range.start.0 && range.start.0 < link.range.end.0)
                        || (range.start == link.range.start && self.affinity == Affinity::Forward)
                        || (range.start == link.range.end && self.affinity == Affinity::Backward)
                } else {
                    link.range.start.0 <= range.start.0 && range.end.0 <= link.range.end.0
                }
            }),
            work,
        ))
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
        let (link, inspection_work) = self.inspect_link_with_work(expected, range)?;
        if link
            .as_ref()
            .is_some_and(|link| link.destination == destination)
            || link.is_none() && destination.is_empty()
        {
            return Ok(None);
        }
        let target = link.map_or(range, |link| link.range);
        if self
            .projection
            .block_lines(target)
            .iter()
            .any(|line| line.code)
        {
            return Ok(None);
        }
        let inserting = target.start == target.end;
        let (mut plan, selected_source) = if inserting {
            (
                self.projection.insert_link(
                    &self.source,
                    target,
                    destination,
                    self.input_affinity(range),
                    self.pending_formats.as_deref(),
                )?,
                None,
            )
        } else {
            let (plan, selection) =
                self.projection
                    .link_edit(&self.source, target, range, destination)?;
            (plan, Some(selection))
        };
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let prepared = self.prepare_plan_pending(&edit, &plan, &before_links, None)?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut change = self.apply(&edit);
        self.install_plan_pending(&mut plan, prepared, &mut change, true);
        self.selection = if inserting {
            let at = DisplayOffset(self.projection.display_at(plan.caret));
            DisplayRange { start: at, end: at }
        } else {
            let source = selected_source.unwrap();
            DisplayRange {
                start: DisplayOffset(self.projection.display_at(source.start.0)),
                end: DisplayOffset(self.projection.display_at(source.end.0)),
            }
        };
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        change.work.link_metadata_items += plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes + inspection_work.copied;
        change.work.link_metadata_items += inspection_work.items;
        let (after_source, after_source_work) = self.capture_history_selection();
        change.work.link_metadata_items += before_source_work + after_source_work;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        self.record_input_history(
            HistoryEntry {
                before_source,
                after_source,
                before_selection,
                before_affinity,
                before_formats,
                before_links,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
                after_links,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            },
            None,
        );
        Ok(Some(change))
    }
}
