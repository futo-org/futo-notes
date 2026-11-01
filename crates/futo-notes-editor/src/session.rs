mod blocks;
pub(crate) mod bounded;
mod composition;
mod front_matter;
mod os_replacement;
mod paragraphs;
mod relink;
pub use blocks::BlockCommand;
pub use relink::OwnActionRelink;
mod history_selection;
mod input;
mod links;
mod pending;
mod staging;
mod transaction;
use crate::history::{
    HistoryClock, HistoryEntry, HistoryGroup, HistoryInput, MonotonicClock, TypingRun,
};
pub use composition::Composition;
pub use paragraphs::ParagraphKey;
use ropey::Rope;
use std::sync::Arc;
use transaction::InputMapping;

use crate::{
    Affinity, DisplayOffset, DisplayRange, EditWork, EditorError, InlineFormat, ProjectionSlice,
    Revision, SelectionChange, SourceEdit, SourceOffset, SourceRange, ViewChange,
};

// Planning work never represents an extra accepted insertion.
fn accumulate_planning_work(total: &mut EditWork, part: EditWork) {
    total.materialized_source_bytes += part.materialized_source_bytes;
    total.parsed_source_bytes += part.parsed_source_bytes;
    total.link_metadata_items += part.link_metadata_items;
    total.link_copied_bytes += part.link_copied_bytes;
}

/// Exact-source editor session. Hosts must not use this development surface as
/// a replacement shipping renderer until renderer integration is complete.
pub struct EditorSession {
    pub(crate) source: Rope,
    pub(crate) projection: crate::inline::Projection,
    revision: Revision,
    selection: DisplayRange,
    affinity: Affinity,
    pending_formats: Option<Vec<InlineFormat>>,
    undo: Vec<HistoryGroup>,
    redo: Vec<HistoryGroup>,
    clock: Arc<dyn HistoryClock>,
    typing: Option<TypingRun>,
    composition: Option<Composition>,
    bounded_incarnation: u64,
    bounded_work: crate::BoundedWork,
    context: staging::StageContext,
}

impl EditorSession {
    pub fn open(source: &str) -> Self {
        Self::restore(source, Revision(0))
    }

    /// Starts a recovered session without persistent undo history.
    pub fn restore(source: &str, revision: Revision) -> Self {
        Self::restore_with_clock(source, revision, Arc::new(MonotonicClock::default()))
    }

    pub fn open_with_clock(source: &str, clock: Arc<dyn HistoryClock>) -> Self {
        Self::restore_with_clock(source, Revision(0), clock)
    }

    pub fn restore_with_clock(
        source: &str,
        revision: Revision,
        clock: Arc<dyn HistoryClock>,
    ) -> Self {
        Self::with_projection(
            source,
            revision,
            clock,
            crate::inline::Projection::new(source),
        )
    }

    fn with_projection(
        source: &str,
        revision: Revision,
        clock: Arc<dyn HistoryClock>,
        projection: crate::inline::Projection,
    ) -> Self {
        let body = DisplayOffset(projection.body_start());
        Self {
            source: Rope::from_str(source),
            projection,
            revision,
            selection: DisplayRange {
                start: body,
                end: body,
            },
            affinity: Affinity::Forward,
            pending_formats: None,
            undo: Vec::new(),
            redo: Vec::new(),
            clock,
            typing: None,
            composition: None,
            bounded_incarnation: 0,
            bounded_work: crate::BoundedWork::default(),
            context: staging::StageContext::complete_source(),
        }
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    /// Explicit whole-text query; never called by the input path.
    pub fn source_text(&self) -> String {
        self.source.to_string()
    }

    pub fn display_text(&self) -> String {
        self.projection.display.to_string()
    }

    pub fn selection(&self) -> DisplayRange {
        self.selection
    }

    pub fn affinity(&self) -> Affinity {
        self.affinity
    }

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        if let Some(formats) = &self.pending_formats {
            return formats.clone();
        }
        let source = self
            .source_at(self.revision, self.selection.start, self.affinity)
            .unwrap();
        let mut formats = self.projection.formats_at(source.0);
        formats.sort();
        formats.dedup();
        formats
    }

    pub fn select(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<SelectionChange, EditorError> {
        let affinity = if range.start.0 == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        };
        self.select_with_affinity(expected, range, affinity)
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let range = self.outside_metadata(range);
        if self.composition.is_some() {
            return Ok(SelectionChange {
                revision: self.revision,
                selection: self.selection,
                affinity: self.affinity,
            });
        }
        if self.selection != range || self.affinity != affinity {
            self.typing = None;
            self.pending_formats = None;
        }
        self.selection = range;
        self.affinity = affinity;
        Ok(SelectionChange {
            revision: self.revision,
            selection: range,
            affinity,
        })
    }

    fn validate_range(&self, range: DisplayRange) -> Result<(), EditorError> {
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        self.char_index(range.start)?;
        self.char_index(range.end)?;
        Ok(())
    }

    fn input_affinity(&self, range: DisplayRange) -> Affinity {
        if range == self.selection {
            self.affinity
        } else if range.start.0 == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        }
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: DisplayOffset,
        affinity: Affinity,
    ) -> Result<SourceOffset, EditorError> {
        self.check_revision(expected)?;
        self.char_index(offset)?;
        let (low, high) = self.projection.source_bounds(offset.0);
        Ok(SourceOffset(match affinity {
            Affinity::Backward => low,
            Affinity::Forward => high,
        }))
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        Ok(self.projection.query(self.revision, range))
    }

    /// Validate ordering before a host converts fixed-width foreign coordinates.
    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorError> {
        if expected == self.revision {
            Ok(())
        } else {
            Err(EditorError::StaleRevision {
                expected,
                actual: self.revision,
            })
        }
    }

    pub(crate) fn char_index(&self, offset: DisplayOffset) -> Result<usize, EditorError> {
        let index = self
            .projection
            .display
            .try_byte_to_char(offset.0)
            .map_err(|_| EditorError::InvalidRange)?;
        if self.projection.display.char_to_byte(index) != offset.0 {
            return Err(EditorError::InvalidRange);
        }
        Ok(index)
    }

    pub(super) fn prepare_exact_source(
        &self,
        expected: Revision,
        range: SourceRange,
        inserted: &str,
    ) -> Result<SourceEdit, EditorError> {
        self.check_revision(expected)?;
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        let start = self
            .source
            .try_byte_to_char(range.start.0)
            .map_err(|_| EditorError::InvalidRange)?;
        let end = self
            .source
            .try_byte_to_char(range.end.0)
            .map_err(|_| EditorError::InvalidRange)?;
        if self.source.char_to_byte(start) != range.start.0
            || self.source.char_to_byte(end) != range.end.0
        {
            return Err(EditorError::InvalidRange);
        }
        Ok(SourceEdit {
            previous_revision: self.revision,
            revision: Revision(
                self.revision
                    .0
                    .checked_add(1)
                    .ok_or(EditorError::RevisionExhausted)?,
            ),
            range,
            removed: self.source.slice(start..end).to_string(),
            inserted: inserted.to_owned(),
        })
    }

    fn apply(&mut self, edit: &SourceEdit) -> ViewChange {
        let mirror_bytes = self
            .context
            .origin
            .as_mut()
            .map_or(0, |origin| origin.mirror(edit));
        let start = self.source.byte_to_char(edit.range.start.0);
        let end = self.source.byte_to_char(edit.range.end.0);
        self.source.remove(start..end);
        self.source.insert(start, &edit.inserted);
        let update = self
            .projection
            .apply(&self.source, edit, self.context.origin.as_ref());
        self.revision = edit.revision;
        let caret = DisplayOffset(
            self.projection
                .display_at(edit.range.start.0 + edit.inserted.len()),
        );
        self.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        let (projection, link_work) = self
            .projection
            .query_with_work(self.revision, update.semantic_range);
        ViewChange {
            previous_revision: edit.previous_revision,
            revision: edit.revision,
            range: update.range,
            inserted: update.inserted,
            selection: self.selection,
            affinity: self.affinity,
            projection,
            work: EditWork {
                materialized_source_bytes: edit.removed.len()
                    + update.materialized_source_bytes
                    + mirror_bytes,
                inserted_bytes: edit.inserted.len(),
                parsed_source_bytes: update.parsed_source_bytes,
                link_metadata_items: update.link_metadata_items
                    + link_work.items
                    + usize::from(self.context.origin.is_some()),
                link_copied_bytes: update.link_copied_bytes + link_work.copied,
            },
        }
    }

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
        if self
            .projection
            .block_lines(self.selection)
            .iter()
            .all(|line| line.code)
        {
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
            crate::inline::EditIntent::Toggle(format),
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
        self.undo.push(HistoryGroup {
            entries: vec![HistoryEntry {
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
            }],
        });
        self.typing = None;
        self.redo.clear();
        Ok(Some(change))
    }

    /// Replay accepts only a record that matches both revision and exact bytes.
    pub fn replay(&mut self, edit: &SourceEdit) -> Result<ViewChange, EditorError> {
        self.replay_with_accept(edit, &mut |_| Ok(()))
    }

    /// Validate exact source before host acceptance; failed records leave state intact.
    pub fn replay_with_accept(
        &mut self,
        edit: &SourceEdit,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(edit.previous_revision)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        if self.prepare_exact_source(edit.previous_revision, edit.range, &edit.inserted)? != *edit {
            return Err(EditorError::RecoveryMismatch);
        }
        accept(edit).map_err(EditorError::Persistence)?;
        Ok(self.apply(edit))
    }

    pub fn undo(
        &mut self,
        expected: Revision,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.history(expected, false, accept)
    }

    pub fn redo(
        &mut self,
        expected: Revision,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.history(expected, true, accept)
    }

    fn history(
        &mut self,
        expected: Revision,
        redo: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Ok(None);
        }
        let Some(entry) = (if redo { &self.redo } else { &self.undo }).last() else {
            return Ok(None);
        };
        let mut transaction = crate::history::Transaction::new(&self.source);
        let entries: Box<dyn Iterator<Item = &HistoryEntry>> = if redo {
            Box::new(entry.entries.iter())
        } else {
            Box::new(entry.entries.iter().rev())
        };
        for step in entries {
            let (range, inserted) = if redo {
                (step.range, step.inserted.as_str())
            } else {
                (
                    SourceRange {
                        start: step.range.start,
                        end: SourceOffset(step.range.start.0 + step.inserted.len()),
                    },
                    step.removed.as_str(),
                )
            };
            transaction.apply(range, inserted);
        }
        let (range, inserted) = transaction.finish();
        let edit = self.prepare_source(expected, range, &inserted)?;
        let target = if redo {
            &entry.entries.last().unwrap().after_links
        } else {
            &entry.entries.first().unwrap().before_links
        };
        let guarded_preview = if !target.has_words() {
            None
        } else {
            let opening = self.projection.pending_for_source_edit(edit.range);
            let mut preview =
                self.preview_pending_edit(&edit, opening.window, target, true, &[])?;
            preview.work.link_metadata_items += opening.work;
            Some(preview)
        };
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        change.work.materialized_source_bytes += edit.inserted.len();
        if let Some(preview) = guarded_preview {
            change.work.materialized_source_bytes += preview.work.materialized_source_bytes;
            change.work.parsed_source_bytes += preview.work.parsed_source_bytes;
            change.work.link_metadata_items += preview.work.link_metadata_items;
            change.work.link_copied_bytes += preview.work.link_copied_bytes;
        }
        let entry = if redo {
            self.redo.pop().unwrap()
        } else {
            self.undo.pop().unwrap()
        };
        let step = if redo {
            entry.entries.last().unwrap()
        } else {
            entry.entries.first().unwrap()
        };
        let (selection, selection_work) = self.project_history_selection(
            if redo {
                step.after_source
            } else {
                step.before_source
            },
            if redo {
                step.after_selection
            } else {
                step.before_selection
            },
        );
        self.selection = selection;
        change.work.link_metadata_items += selection_work;
        self.affinity = if redo {
            entry.entries.last().unwrap().after_affinity
        } else {
            entry.entries.first().unwrap().before_affinity
        };
        change.selection = self.selection;
        change.affinity = self.affinity;
        self.pending_formats = if redo {
            entry.entries.last().unwrap().after_formats.clone()
        } else {
            entry.entries.first().unwrap().before_formats.clone()
        };
        let pending = if redo {
            &entry.entries.last().unwrap().after_links
        } else {
            &entry.entries.first().unwrap().before_links
        };
        change.work.link_metadata_items += self.projection.restore_pending(pending);
        let (projection, link_work) = self
            .projection
            .query_with_work(self.revision, change.projection.range);
        change.projection = projection;
        change.work.link_metadata_items += link_work.items;
        change.work.link_copied_bytes += link_work.copied;
        self.typing = None;
        if redo {
            self.undo.push(entry);
        } else {
            self.redo.push(entry);
        }
        Ok(Some(change))
    }
}
