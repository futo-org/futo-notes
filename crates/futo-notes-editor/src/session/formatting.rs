//! Inline format toggles through the ordinary accepted history path.

use super::*;
use crate::history::Transaction;
mod at_once;
#[cfg(test)]
mod at_once_tests;
mod bodies;
mod link_bodies;
use bodies::{Bodies, Body};
#[cfg(test)]
mod fuzz_tests;

impl EditorSession {
    /// A collapsed toggle changes the carried format without writing empty
    /// markdown. A selected toggle is one accepted, byte-exact history action.
    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let committed = self.commit_composition(expected, None, accept)?;
        if self.projection.all_code_lines(self.selection) {
            return Ok(committed);
        }
        if self.selection.start == self.selection.end {
            let mut formats = self.active_formats();
            if formats.contains(&format) {
                formats.retain(|value| *value != format);
            } else {
                formats.push(format);
                formats.sort();
            }
            self.pending_formats = Some(formats);
            self.typing = None;
            return Ok(committed);
        }
        let Bodies { multi, bodies } = self.format_bodies(self.selection);
        if multi {
            return self
                .toggle_bodies(expected, format, &bodies, accept)
                .map(Some);
        }
        self.toggle_selected(expected, format, None, accept)
            .map(Some)
    }

    /// Toggle the current selection as one inline run. `direction`:
    /// `Some(add)` forces adding or removing; `None` reads the selection.
    fn toggle_selected(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        direction: Option<bool>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut plan = self.projection.edit(
            &self.source,
            self.selection,
            "",
            self.affinity,
            None,
            crate::inline::EditIntent::Toggle(format, direction),
        )?;
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
        let mut change = self.apply(&edit);
        self.install_plan_pending(&mut plan, prepared, &mut change, true);
        self.selection = before_selection;
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        change.work.link_metadata_items += plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes;
        let (after_source, after_source_work) = self.capture_history_selection();
        change.work.link_metadata_items += before_source_work + after_source_work;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        self.undo.push(HistoryGroup::new(vec![HistoryEntry {
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
        }]));
        self.typing = None;
        self.redo.clear();
        Ok(change)
    }
}

impl EditorSession {
    /// The formats a selected toggle would remove: for a multi-body
    /// selection those every body carries, else those the whole run carries.
    /// `lines` are `range`'s format block lines.
    pub(super) fn selected_toggle_formats(
        &self,
        range: DisplayRange,
        lines: &[crate::inline::blocks::BlockLine],
    ) -> Vec<InlineFormat> {
        let Bodies { multi, bodies } = self.bodies_in(range, lines);
        if !multi {
            return self.projection.selection_formats(range);
        }
        let projection = &self.projection;
        let each = crate::parallel::map(&bodies, |body| projection.selection_formats(body.range));
        let mut common: Option<Vec<InlineFormat>> = None;
        for formats in each {
            match &mut common {
                Some(common) => common.retain(|format| formats.contains(format)),
                None => common = Some(formats),
            }
            if common.as_ref().is_some_and(Vec::is_empty) {
                break;
            }
        }
        common.unwrap_or_default()
    }

    /// A selection over several bodies: one direction for all of them (add
    /// unless every body already carries the format), each body toggled
    /// locally, then one acceptance and one Undo group. Bodies that cannot
    /// take the format are skipped; refusing all refuses. Independent bodies
    /// are planned in one pass over the unchanged note; anything else is
    /// toggled body by body on one staged window.
    fn toggle_bodies(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        bodies: &[Body],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let projection = &self.projection;
        let carried = crate::parallel::map(bodies, |body| {
            projection.selection_formats(body.range).contains(&format)
        });
        let add = !carried.iter().all(|carried| *carried);
        let (edit, pending, guard_validation, work) = if let Some((range, inserted, work)) =
            self.plan_bodies_at_once(format, add, bodies, &carried)
        {
            let edit = self.prepare_source(expected, range, &inserted)?;
            (edit, None, EditWork::default(), work)
        } else {
            let (window, staged, transaction, work) = self.stage_bodies(format, add, bodies)?;
            let transaction = transaction.ok_or(EditorError::UnrepresentableFormat)?;
            let (mut source_range, inserted) = transaction.finish();
            source_range.start.0 += window.start;
            source_range.end.0 += window.start;
            let edit = self.prepare_source(expected, source_range, &inserted)?;
            let pending = staged.prepare_pending_for_parent(window.start);
            let guard_validation = self.validate_stage_guards(&edit, window, &pending)?;
            (edit, Some(pending), guard_validation, work)
        };
        self.commit_bodies(edit, pending, guard_validation, work, false, accept)
    }

    /// Accept a planned multi-body edit as one history action, keeping the
    /// selection (`on_text`: the same text, wherever the edit moved it).
    fn commit_bodies(
        &mut self,
        edit: SourceEdit,
        pending: Option<crate::inline::PendingLinks>,
        guard_validation: EditWork,
        work: EditWork,
        on_text: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        // No host-visible changes, history or clock boundaries before acceptance.
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let anchors = on_text.then(|| {
            let (start, end) = (before_selection.start.0, before_selection.end.0);
            (
                self.projection.source_bounds(start).1,
                self.projection.source_bounds(end).0,
                self.projection.display_at(edit.range.start.0),
            )
        });
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let mut change = self.apply(&edit);
        if let Some(pending) = &pending {
            self.adopt_stage_pending(pending, &mut change);
        }
        accumulate_planning_work(&mut change.work, guard_validation);
        accumulate_planning_work(&mut change.work, work);
        change.work.materialized_source_bytes += edit.inserted.len();
        self.selection = anchors.map_or(before_selection, |(start, end, edit_at)| {
            // The same text: an edge outside the edit follows its source
            // offset (a definition revealed above shifts it on screen); one
            // inside the rewritten span stays, moved only by that shift.
            let (from, to) = (edit.range.start.0, edit.range.end.0);
            let shift = self.projection.display_at(from) as isize - edit_at as isize;
            let place = |source: usize, display: usize| {
                DisplayOffset(if source <= from {
                    self.projection.display_at(source)
                } else if source >= to {
                    self.projection
                        .display_at(source + edit.inserted.len() - edit.removed.len())
                } else {
                    display.saturating_add_signed(shift)
                })
            };
            DisplayRange {
                start: place(start, before_selection.start.0),
                end: place(end, before_selection.end.0),
            }
        });
        self.pending_formats = None;
        change.selection = self.selection;
        change.affinity = self.affinity;
        let (after_source, after_source_work) = self.capture_history_selection();
        change.work.link_metadata_items += before_source_work + after_source_work;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        self.undo.push(HistoryGroup::new(vec![HistoryEntry {
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
        }]));
        self.typing = None;
        self.redo.clear();
        Ok(change)
    }

    /// Every body's toggle on one staged window of the selection, recorded
    /// into one transaction; `None` when no body could take the format.
    fn stage_bodies(
        &self,
        format: InlineFormat,
        add: bool,
        bodies: &[Body],
    ) -> Result<(std::ops::Range<usize>, Self, Option<Transaction>, EditWork), EditorError> {
        let carries = |range: DisplayRange| self.carries_format(range, format);
        let (window, display_start) = self.projection.edit_window(self.selection);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone())?;
        let mut transaction = Transaction::new(&staged.source);
        let mut work = EditWork {
            materialized_source_bytes: raw.len(),
            parsed_source_bytes: staged.projection.initial_parse_work,
            link_metadata_items: staged.projection.initial_link_metadata_items + 2 * bodies.len(),
            link_copied_bytes: staged.projection.initial_link_copied_bytes,
            ..EditWork::default()
        };
        let mut applied = false;
        // Toggling never changes display text, so every body keeps its
        // opening display range in the staged window.
        let local = |range: DisplayRange| DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        for body in bodies {
            if add && carries(body.range) {
                continue;
            }
            let mut toggle = |range| {
                staged.toggle_staged(
                    local(range),
                    format,
                    add,
                    body.cell,
                    &mut transaction,
                    &mut work,
                )
            };
            if toggle(body.range)? {
                applied = true;
            } else if body.lines.len() > 1 {
                // A body the planner cannot take whole may still take each
                // of its physical lines.
                for &line in &body.lines {
                    if !(add && carries(line)) {
                        applied |= toggle(line)?;
                    }
                }
            }
        }
        Ok((window, staged, applied.then_some(transaction), work))
    }

    /// One body's toggle on a staged session, recorded into `transaction`.
    /// `Ok(false)`: the body cannot take the format and nothing changed.
    fn toggle_staged(
        &mut self,
        range: DisplayRange,
        format: InlineFormat,
        add: bool,
        cell: bool,
        transaction: &mut Transaction,
        work: &mut EditWork,
    ) -> Result<bool, EditorError> {
        self.select_with_affinity(self.revision, range, Affinity::Forward)?;
        self.pending_formats = None;
        let result = self.toggle_selected(self.revision, format, Some(add), &mut |edit| {
            // A cell's markers may never add or remove a cell boundary.
            if cell
                && (crate::table::pipe_count(&edit.removed)
                    != crate::table::pipe_count(&edit.inserted)
                    || edit.inserted.contains(['\r', '\n']))
            {
                return Err(String::new());
            }
            transaction.apply(edit.range, &edit.inserted);
            Ok(())
        });
        match result {
            Ok(change) => {
                accumulate_planning_work(work, change.work);
                Ok(true)
            }
            Err(EditorError::UnrepresentableFormat | EditorError::Persistence(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }
}
