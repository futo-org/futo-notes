mod blocks;
mod checked_input;
mod composition;
mod external;
mod find;
#[cfg(feature = "engine")]
mod next;
mod written;
pub use external::ExternalSourceAdoption;
mod formatting;
mod front_matter;
mod os_replacement;
mod paragraphs;
mod relink;
pub use blocks::BlockCommand;
mod history_selection;
mod images;
mod input;
mod links;
mod note_ids;
mod pending;
mod staging;
mod tags;
mod toolbar;
pub use toolbar::{ToolbarList, ToolbarState};
mod transaction;
mod wikilink_completion;
use crate::history::{
    HistoryClock, HistoryEntry, HistoryGroup, HistoryInput, MonotonicClock, TypingRun,
};
pub use composition::{Composition, MarkedRun};
pub use find::{FindReport, FindScanRequest, FindScanResult, FindWork};
pub use paragraphs::ParagraphKey;
use ropey::Rope;
use std::sync::Arc;
use transaction::{accumulate_planning_work, InputMapping};

use crate::{
    Affinity, DisplayOffset, DisplayRange, EditWork, EditorError, InlineFormat, ProjectionSlice,
    Revision, SelectionChange, SourceEdit, SourceOffset, SourceRange, ViewChange,
};

/// Exact-source editor session. Hosts must not use this development surface as
/// a replacement shipping renderer until renderer integration is complete.
pub struct EditorSession {
    pub(crate) source: Rope,
    pub(crate) projection: crate::inline::Projection,
    revision: Revision,
    selection: DisplayRange,
    affinity: Affinity,
    pending_formats: Option<Vec<InlineFormat>>,
    /// Set while a word replacement ending at the caret is planned as one run: the carried
    /// formats cover the whole run, not only the letters added after the caret's word.
    word_takes_carried: bool,
    /// The caret's formats before the toggles that set `pending_formats` there, kept with the
    /// revision and selection they were read at: what a toggle changed, not what typing carried.
    toggled_from: Option<(Revision, DisplayRange, Vec<InlineFormat>)>,
    undo: Vec<HistoryGroup>,
    redo: Vec<HistoryGroup>,
    clock: Arc<dyn HistoryClock>,
    typing: Option<TypingRun>,
    composition: Option<Composition>,
    context: staging::StageContext,
    find: find::FindState,
    /// Names this session for async claims; never reused within a process.
    incarnation: u64,
    /// Escapes the engine wrote just before the caret while it was typed.
    written_run: Option<written::WrittenRun>,
    last_edit: Option<written::LastEdit>,
    /// The rebuilt core, under the `engine` feature (`session/next.rs`).
    #[cfg(feature = "engine")]
    pub(crate) next: Option<Box<crate::engine::Engine>>,
}

impl EditorSession {
    pub fn open(source: &str) -> Self {
        Self::restore(source, Revision(0))
    }

    /// Starts a session at a given revision without persistent undo history.
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
        #[cfg(feature = "engine")]
        return Self::on_engine(source, revision, clock);
        #[cfg(not(feature = "engine"))]
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
            word_takes_carried: false,
            toggled_from: None,
            undo: Vec::new(),
            redo: Vec::new(),
            clock,
            typing: None,
            composition: None,
            context: staging::StageContext::complete_source(),
            find: find::FindState::default(),
            incarnation: images::next_incarnation(),
            written_run: None,
            last_edit: None,
            #[cfg(feature = "engine")]
            next: None,
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
        on_next!(ref self, |e| e.display_text());
        self.projection.display.to_string()
    }

    pub fn selection(&self) -> DisplayRange {
        self.selection
    }

    pub fn affinity(&self) -> Affinity {
        self.affinity
    }

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        on_next!(ref self, |e| e.active_formats());
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
        on_next!(self, |e| e.select_with_affinity(expected, range, affinity));
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let range = self.outside_metadata(self.outside_crlf(range));
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

    /// A CRLF is one line break: a caret between its CR and LF moves before
    /// the CR, to the end of its line, and a selection grows to cover the whole
    /// break. Keys and typing there would otherwise split the pair into a bare
    /// CR line ending or refuse.
    pub(crate) fn outside_crlf(&self, mut range: DisplayRange) -> DisplayRange {
        let display = &self.projection.display;
        let inside = |at: usize| {
            at > 0
                && at < display.len_bytes()
                && display.byte(at - 1) == b'\r'
                && display.byte(at) == b'\n'
        };
        let collapsed = range.start == range.end;
        if inside(range.start.0) {
            range.start.0 -= 1;
        }
        if inside(range.end.0) {
            range.end.0 = if collapsed {
                range.start.0
            } else {
                range.end.0 + 1
            };
        }
        range
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
        on_next!(ref self, |e| e.source_at(expected, offset, affinity));
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
        on_next!(ref self, |e| e.project(expected, range));
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
        self.note_applied(edit);
        self.find.edited(update.range, update.inserted.len());
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
        on_next!(self, accept, |e, accept| e.replay_view(edit, accept));
        self.check_revision(edit.previous_revision)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        if self.prepare_exact_source(edit.previous_revision, edit.range, &edit.inserted)? != *edit {
            return Err(EditorError::ReplayMismatch);
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
        on_next!(self, accept, |e, accept| e
            .history_view(expected, redo, accept));
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
        let (restore_work, restored) = self.projection.restore_pending_changed(pending);
        change.work.link_metadata_items += restore_work;
        // The apply above already queried this range; only restored transient
        // fields can make that answer stale.
        if restored {
            let (projection, link_work) = self
                .projection
                .query_with_work(self.revision, change.projection.range);
            change.projection = projection;
            change.work.link_metadata_items += link_work.items;
            change.work.link_copied_bytes += link_work.copied;
        }
        self.typing = None;
        self.restore_written(&entry.written[usize::from(redo)]);
        if redo {
            self.undo.push(entry);
        } else {
            self.redo.push(entry);
        }
        Ok(Some(change))
    }
}
