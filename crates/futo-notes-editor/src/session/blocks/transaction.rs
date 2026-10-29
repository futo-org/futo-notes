//! Compound block planning stays invisible until one recovery acceptance.
use super::*;

impl EditorSession {
    pub(super) fn stage_block_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        operation: impl FnOnce(
            &mut Self,
            DisplayRange,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        staged.select_with_affinity(staged.revision(), local, self.affinity)?;
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
            Some(selection),
            None,
            accept,
        )?;
        self.pending_formats = staged.pending_formats;
        self.undo
            .last_mut()
            .unwrap()
            .entries
            .last_mut()
            .unwrap()
            .after_formats = self.pending_formats.clone();
        change.work.materialized_source_bytes += raw.len() + step.work.materialized_source_bytes;
        change.work.parsed_source_bytes += 2 * raw.len() + step.work.parsed_source_bytes;
        Ok(Some(change))
    }

    pub(super) fn split_inline_block_seams(
        &mut self,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(plan) = self.projection.split_block_lines(&self.source, range)? else {
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
        Ok(Some(change))
    }
}
