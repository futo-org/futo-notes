//! Compound block planning stays invisible until one recovery acceptance.
use super::*;

impl EditorSession {
    pub(in crate::session) fn stage_block_action(
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
        self.stage_block_action_inner(
            expected,
            range,
            input,
            false,
            accept,
            |staged, local, accept| {
                operation(staged, local, accept).map(|step| step.map(|step| (step, None)))
            },
        )
        .map(|result| result.map(|(change, _)| change))
    }

    pub(super) fn stage_mapped_block_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        input: Option<HistoryInput<'_>>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        operation: impl FnOnce(
            &mut Self,
            DisplayRange,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<(ViewChange, InputMapping)>, EditorError>,
    ) -> Result<Option<(ViewChange, InputMapping)>, EditorError> {
        self.stage_block_action_inner(
            expected,
            range,
            input,
            true,
            accept,
            |staged, local, accept| {
                operation(staged, local, accept)
                    .map(|step| step.map(|(step, mapping)| (step, Some(mapping))))
            },
        )
        .map(|result| result.map(|(change, mapping)| (change, mapping.unwrap())))
    }

    fn stage_block_action_inner(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        input: Option<HistoryInput<'_>>,
        capture_steps: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        operation: impl FnOnce(
            &mut Self,
            DisplayRange,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        )
            -> Result<Option<(ViewChange, Option<InputMapping>)>, EditorError>,
    ) -> Result<Option<(ViewChange, Option<InputMapping>)>, EditorError> {
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone())?;
        let display_window = display_start..display_start + staged.projection.display.len_bytes();
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        staged.select_with_affinity(staged.revision(), local, self.input_affinity(range))?;
        if range == self.selection {
            staged.pending_formats = self.pending_formats.clone();
        }
        let mut transaction = crate::history::Transaction::new(&staged.source);
        let mut steps = [None, None];
        let mut count = 0;
        let Some((step, mapping)) = operation(&mut staged, local, &mut |edit| {
            if capture_steps && count < steps.len() {
                steps[count] = Some(super::super::transaction::SourceStep::read(edit));
            }
            count += usize::from(capture_steps);
            transaction.apply(edit.range, &edit.inserted);
            Ok(())
        })?
        else {
            return Ok(None);
        };
        let (mut footprint, inserted) = transaction.finish();
        footprint.start.0 += window.start;
        footprint.end.0 += window.start;
        let mut selection_work = 0;
        let mapped = mapping.is_some();
        let prepared = if mapped {
            Some(self.prepare_source(expected, footprint, &inserted)?)
        } else {
            None
        };
        let mapping = if let Some(mut mapping) = mapping {
            let edit = prepared.as_ref().unwrap();
            mapping.relocate_display(display_start);
            Some(mapping.protect(&edit, steps, count, window.clone(), display_window)?)
        } else {
            None
        };
        let pending = Some(staged.prepare_pending_for_parent(window.start));
        // Only a genuine resolver mutation can change display before this
        // exact source window. Preserve actual atoms, not its opening base.
        let selection = if mapped || staged.projection.has_rebuilt_references {
            let (mut exact, work) = staged
                .projection
                .source_selection(staged.selection, staged.affinity);
            exact.start.source.0 += window.start;
            exact.end.source.0 += window.start;
            selection_work = work + 2;
            BlockSelection::Exact {
                selection: exact,
                window: window.clone(),
            }
        } else {
            BlockSelection::Display(DisplayRange {
                start: DisplayOffset(display_start + staged.selection.start.0),
                end: DisplayOffset(display_start + staged.selection.end.0),
            })
        };
        let mut change = if let Some(edit) = prepared {
            self.commit_prepared_block_with_pending(edit, selection, input, pending, accept)?
        } else {
            self.commit_block_with_pending(
                expected,
                footprint.start.0..footprint.end.0,
                &inserted,
                selection,
                input,
                pending,
                accept,
            )?
        };
        change.work.link_metadata_items += selection_work + if mapped { count * 4 + 9 } else { 0 };
        self.carry_block_state(&mut change, staged.pending_formats, staged.affinity);
        change.work.materialized_source_bytes += raw.len() + step.work.materialized_source_bytes;
        change.work.parsed_source_bytes +=
            staged.projection.initial_parse_work + step.work.parsed_source_bytes;
        change.work.link_metadata_items +=
            staged.projection.initial_link_metadata_items + step.work.link_metadata_items;
        change.work.link_copied_bytes +=
            staged.projection.initial_link_copied_bytes + step.work.link_copied_bytes;
        Ok(Some((change, mapping)))
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
        let Some(mut plan) = self
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
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let prepared = self.prepare_plan_pending(&edit, &plan, &before_links, None)?;
        let mut change = self.replay_with_accept(&edit, accept)?;
        self.install_plan_pending(&mut plan, prepared, &mut change, true);
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        change.work.link_metadata_items += plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes;
        Ok(Some(change))
    }
}
