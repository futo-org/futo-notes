//! A multi-run replacement is planned entirely before one host acceptance.
use super::*;
use crate::history::Transaction;
use crate::{DisplayReplacement, InputAction};
mod mapping;
pub(super) use mapping::{InputMapping, SourceStep};

/// A target in the intended replacement result belongs either to unchanged
/// opening text or to a specific inserted run. Keep that identity through the
/// protected structural replacements, including targets inside marked text.
struct SourceAnchor {
    display: usize,
    source: Option<crate::history::SourcePoint>,
}

impl SourceAnchor {
    fn map(
        &mut self,
        edits: &[(Revision, SourceRange, usize)],
        mapping: &InputMapping,
        origin: usize,
        staged: &EditorSession,
        references_changed: bool,
    ) -> Result<usize, EditorError> {
        let mut work = 0;
        for &(revision, range, inserted) in edits {
            work += 1;
            if let Some(mut point) = self.source {
                let source = point.source.0;
                let atom_end = source + point.atom.map_or(0, |atom| atom.source_len);
                let atom_touched =
                    point.atom.is_some() && source < range.end.0 && range.start.0 < atom_end;
                self.source = if !atom_touched && source < range.start.0 {
                    Some(point)
                } else if !atom_touched && range.end.0 <= source {
                    point.source.0 = source - (range.end.0 - range.start.0) + inserted;
                    Some(point)
                } else if !atom_touched && source == range.start.0 && point.within == 0 {
                    Some(point)
                } else {
                    let (mapped, visits) =
                        mapping.retained_source(revision, range, inserted, point);
                    work += visits;
                    mapped
                };
            }
        }
        work += 1;
        let (requires_source, visits) = mapping.requires_source_at_display(self.display, origin);
        work += visits;
        self.display = if let Some(point) = self.source {
            let (display, visits) = staged.projection.try_project_source_point(point);
            work += visits;
            origin + display.ok_or(EditorError::UnrepresentableFormat)?
        } else if references_changed || requires_source {
            return Err(EditorError::UnrepresentableFormat);
        } else {
            let display = mapping.map(self.display, origin)?;
            if let Some(local) = display
                .checked_sub(origin)
                .filter(|local| *local <= staged.projection.display.len_bytes())
            {
                let (selected, visits) = staged.projection.source_selection(
                    DisplayRange {
                        start: DisplayOffset(local),
                        end: DisplayOffset(local),
                    },
                    Affinity::Forward,
                );
                work += visits;
                self.source = Some(selected.start);
            }
            display
        };
        Ok(work)
    }
}

enum ResultTarget {
    Opening(SourceAnchor),
    Inserted { run: usize, within: usize },
}

impl ResultTarget {
    fn new(replacements: &[DisplayReplacement], offset: usize) -> Self {
        let (mut old_end, mut new_end) = (0, 0);
        for (run, replacement) in replacements.iter().enumerate() {
            let start = new_end + replacement.range.start.0 - old_end;
            if offset < start {
                return Self::Opening(SourceAnchor {
                    display: offset + old_end - new_end,
                    source: None,
                });
            }
            if offset <= start + replacement.inserted.len() {
                return Self::Inserted {
                    run,
                    within: offset - start,
                };
            }
            old_end = replacement.range.end.0;
            new_end = start + replacement.inserted.len();
        }
        Self::Opening(SourceAnchor {
            display: offset + old_end - new_end,
            source: None,
        })
    }
}

impl EditorSession {
    /// Apply one user action whose nonoverlapping runs address the opening
    /// display. Unchanged runs retain their original source spelling. Empty,
    /// unordered, overlapping and invalid inputs reject without acceptance.
    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[DisplayReplacement],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        on_next!(self, accept, |e, accept| e.replace_many_view(
            expected,
            &replacements
                .iter()
                .map(|run| (run.range, run.inserted.as_str()))
                .collect::<Vec<_>>(),
            accept
        ));
        self.check_revision(expected)?;
        let runs = replacements.iter();
        let shown = runs.map(|run| (run.range.start.0..run.range.end.0, run.inserted.clone()));
        let shown = crate::inline::Expected::Replaced(shown.collect());
        self.checked_input(shown, accept, |session, accept| {
            if session.composition.is_some() {
                return session.compound_during_composition(expected, replacements, accept);
            }
            let action = InputAction::Isolated;
            session
                .replace_many_with_targets(expected, replacements, &[], action, accept)
                .map(|(change, _)| change)
        })
    }

    pub(super) fn replace_many_with_targets(
        &mut self,
        expected: Revision,
        replacements: &[DisplayReplacement],
        targets: &[usize],
        action: InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(ViewChange, Vec<usize>), EditorError> {
        if replacements.is_empty() {
            return Err(EditorError::InvalidRange);
        }
        for (index, replacement) in replacements.iter().enumerate() {
            self.validate_range(replacement.range)?;
            if index > 0
                && (replacements[index - 1].range.end.0 > replacement.range.start.0
                    || replacements[index - 1].range.start == replacement.range.start)
            {
                return Err(EditorError::InvalidRange);
            }
        }
        let range = DisplayRange {
            start: replacements[0].range.start,
            end: replacements.last().unwrap().range.end,
        };
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone())?;
        let mut transaction = Transaction::new(&staged.source);
        let mut anchor_work = 0;
        let mut anchors: Vec<_> = replacements
            .iter()
            .flat_map(|replacement| [replacement.range.start.0, replacement.range.end.0])
            .map(|offset| {
                let (selected, work) = self.projection.source_selection(
                    DisplayRange {
                        start: DisplayOffset(offset),
                        end: DisplayOffset(offset),
                    },
                    Affinity::Forward,
                );
                anchor_work += work;
                let mut point = selected.start;
                point.source.0 -= window.start;
                SourceAnchor {
                    display: offset - display_start,
                    source: Some(point),
                }
            })
            .collect();
        let mut targets: Vec<_> = targets
            .iter()
            .map(|&offset| ResultTarget::new(replacements, offset))
            .collect();
        for target in &mut targets {
            if let ResultTarget::Opening(anchor) = target {
                let (selected, work) = self.projection.source_selection(
                    DisplayRange {
                        start: DisplayOffset(anchor.display),
                        end: DisplayOffset(anchor.display),
                    },
                    Affinity::Forward,
                );
                anchor_work += work;
                let mut point = selected.start;
                anchor.source = point
                    .source
                    .0
                    .checked_sub(window.start)
                    .filter(|source| *source <= raw.len())
                    .map(|source| {
                        point.source.0 = source;
                        point
                    });
            }
        }
        let mut materialized = raw.len();
        let mut parsed = staged.projection.initial_parse_work;
        let mut link_metadata_items = staged.projection.initial_link_metadata_items + anchor_work;
        let mut link_copied_bytes = staged.projection.initial_link_copied_bytes;
        for (index, replacement) in replacements.iter().enumerate() {
            let local_range = DisplayRange {
                start: DisplayOffset(anchors[2 * index].display),
                end: DisplayOffset(anchors[2 * index + 1].display),
            };
            let affinity = if replacement.range == self.selection {
                self.affinity
            } else if replacement.range.start.0 == 0 {
                Affinity::Forward
            } else {
                Affinity::Backward
            };
            staged.select_with_affinity(staged.revision(), local_range, affinity)?;
            let replaces_selection = replacement.range == self.selection;
            // Whitespace has no visible format, so a run that turns the space before the caret
            // into punctuation (a keyboard's double-space period) is typed there and takes the
            // caret's carried formats. Any other replaced word keeps its own.
            let replaces_space_at_caret = !replaces_selection
                && self.selection.start == self.selection.end
                && replacement.range.end == self.selection.end
                && self
                    .projection
                    .display
                    .byte_slice(replacement.range.start.0..replacement.range.end.0)
                    .chars()
                    .all(char::is_whitespace);
            let own_formats = staged.pending_formats.clone();
            if replaces_selection || replaces_space_at_caret || self.word_takes_carried {
                staged.pending_formats = self.pending_formats.clone();
            }
            let references = staged.projection.references.clone();
            let mut edits = Vec::new();
            let mut accept_edit = |edit: &SourceEdit| {
                edits.push((edit.previous_revision, edit.range, edit.inserted.len()));
                transaction.apply(edit.range, &edit.inserted);
                Ok(())
            };
            let mut planned = staged.replace_action_mapped(
                staged.revision(),
                local_range,
                &replacement.inserted,
                action,
                &mut accept_edit,
            );
            // Carried formats that cannot be spelled around the space leave the run plain, as
            // the replace would have been without them.
            if replaces_space_at_caret && matches!(planned, Err(EditorError::UnrepresentableFormat))
            {
                staged.pending_formats = own_formats;
                planned = staged.replace_action_mapped(
                    staged.revision(),
                    local_range,
                    &replacement.inserted,
                    action,
                    &mut accept_edit,
                );
            }
            let (change, mapping) = planned?;
            let references_changed = !Arc::ptr_eq(&references, &staged.projection.references);
            link_metadata_items += edits.len();
            for anchor in &mut anchors[2 * index + 2..] {
                link_metadata_items +=
                    anchor.map(&edits, &mapping, 0, &staged, references_changed)?;
            }
            for target in &mut targets {
                match target {
                    ResultTarget::Opening(anchor) => {
                        link_metadata_items += anchor.map(
                            &edits,
                            &mapping,
                            display_start,
                            &staged,
                            references_changed,
                        )?;
                    }
                    ResultTarget::Inserted { run, within } if *run == index => {
                        let (at, target_work) =
                            mapping.inserted_target(*within, &replacement.inserted, &staged)?;
                        link_metadata_items += target_work;
                        let (selected, work) = staged.projection.source_selection(
                            DisplayRange {
                                start: DisplayOffset(at),
                                end: DisplayOffset(at),
                            },
                            Affinity::Forward,
                        );
                        link_metadata_items += work;
                        *target = ResultTarget::Opening(SourceAnchor {
                            display: display_start + at,
                            source: Some(selected.start),
                        });
                    }
                    _ => {}
                }
            }
            materialized += change.work.materialized_source_bytes;
            parsed += change.work.parsed_source_bytes;
            link_metadata_items += change.work.link_metadata_items;
            link_copied_bytes += change.work.link_copied_bytes;
        }
        let (mut selected_source, selection_work) = staged
            .projection
            .source_selection(staged.selection, Affinity::Forward);
        link_metadata_items += selection_work + 2;
        selected_source.start.source.0 += window.start;
        selected_source.end.source.0 += window.start;
        let (mut range, inserted) = transaction.finish();
        range.start.0 += window.start;
        range.end.0 += window.start;
        let edit = self.prepare_source(expected, range, &inserted)?;
        let pending = staged.prepare_pending_for_parent(window.start);
        let guard_validation = self.validate_stage_guards(&edit, window.clone(), &pending)?;
        // No host-visible changes, history or clock boundaries before acceptance.
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let mut change = self.apply(&edit);
        self.adopt_stage_pending(&pending, &mut change);
        change.work.materialized_source_bytes += guard_validation.materialized_source_bytes;
        change.work.parsed_source_bytes += guard_validation.parsed_source_bytes;
        change.work.link_metadata_items += guard_validation.link_metadata_items;
        change.work.link_copied_bytes += guard_validation.link_copied_bytes;
        let (start, a) = self.projection.project_source_point(selected_source.start);
        let (end, z) = self.projection.project_source_point(selected_source.end);
        link_metadata_items += a + z;
        self.selection = DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(end),
        };
        let targets = targets
            .into_iter()
            .map(|target| {
                link_metadata_items += 1;
                match target {
                    ResultTarget::Opening(anchor) => match anchor.source {
                        Some(mut point) => {
                            point.source.0 += window.start;
                            let (display, work) = self.projection.project_source_point(point);
                            link_metadata_items += work;
                            display
                        }
                        None => anchor.display,
                    },
                    ResultTarget::Inserted { .. } => unreachable!("every inserted run was staged"),
                }
            })
            .collect();
        self.affinity = staged.affinity;
        self.pending_formats = staged.pending_formats;
        change.selection = self.selection;
        change.affinity = self.affinity;
        change.work.materialized_source_bytes += materialized + edit.inserted.len();
        change.work.parsed_source_bytes += parsed;
        change.work.link_metadata_items += link_metadata_items;
        change.work.link_copied_bytes += link_copied_bytes;
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
            after_formats: self.pending_formats.clone(),
            after_links,
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        }]));
        self.redo.clear();
        self.typing = None;
        Ok((change, targets))
    }
}

// Planning work never represents an extra accepted insertion.
pub(super) fn accumulate_planning_work(total: &mut EditWork, part: EditWork) {
    total.materialized_source_bytes += part.materialized_source_bytes;
    total.parsed_source_bytes += part.parsed_source_bytes;
    total.link_metadata_items += part.link_metadata_items;
    total.link_copied_bytes += part.link_copied_bytes;
}
