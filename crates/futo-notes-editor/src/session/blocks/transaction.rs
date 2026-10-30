//! Compound block planning stays invisible until one recovery acceptance.
use super::*;

impl EditorSession {
    pub(super) fn stage_block_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        input: Option<HistoryInput<'_>>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        operation: impl FnOnce(
            &mut Self,
            DisplayRange,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone());
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        staged.select_with_affinity(staged.revision(), local, self.input_affinity(range))?;
        if range == self.selection {
            staged.pending_formats = self.pending_formats.clone();
        }
        let mut transaction = crate::history::Transaction::new(&staged.source);
        let Some(step) = operation(&mut staged, local, &mut |edit| {
            transaction.apply(edit.range, &edit.inserted);
            Ok(())
        })?
        else {
            return Ok(None);
        };
        let (mut footprint, inserted) = transaction.finish();
        footprint.start.0 += window.start;
        footprint.end.0 += window.start;
        let selection = DisplayRange {
            start: DisplayOffset(display_start + staged.selection.start.0),
            end: DisplayOffset(display_start + staged.selection.end.0),
        };
        let mut change = self.commit_block_edit(
            expected,
            footprint.start.0..footprint.end.0,
            &inserted,
            BlockSelection::Display(selection),
            input,
            accept,
        )?;
        self.carry_block_state(&mut change, staged.pending_formats, staged.affinity);
        change.work.materialized_source_bytes += raw.len() + step.work.materialized_source_bytes;
        change.work.parsed_source_bytes +=
            staged.projection.initial_parse_work + step.work.parsed_source_bytes;
        change.work.link_metadata_items +=
            staged.projection.initial_link_metadata_items + step.work.link_metadata_items;
        change.work.link_copied_bytes +=
            staged.projection.initial_link_copied_bytes + step.work.link_copied_bytes;
        Ok(Some(change))
    }

    pub(super) fn split_inline_block_seams(
        &mut self,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let boundaries = self.projection.line_boundaries(range);
        self.split_inline_block_seams_at(range, &boundaries, accept)
    }

    pub(super) fn split_inline_block_seams_at(
        &mut self,
        range: DisplayRange,
        boundaries: &[usize],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(plan) = self
            .projection
            .split_block_lines(&self.source, range, boundaries)?
        else {
            return Ok(None);
        };
        let edit = self.prepare_source(
            self.revision(),
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        let mut change = self.replay_with_accept(&edit, accept)?;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        change.work.link_metadata_items += plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes;
        Ok(Some(change))
    }
}
