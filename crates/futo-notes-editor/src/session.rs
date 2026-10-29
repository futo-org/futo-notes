use ropey::Rope;

use crate::{
    Affinity, DisplayOffset, DisplayRange, EditWork, EditorError, InlineFormat, ProjectionSlice,
    Revision, SelectionChange, SourceEdit, SourceOffset, SourceRange, ViewChange,
};

struct HistoryEntry {
    before_selection: DisplayRange,
    before_affinity: Affinity,
    before_formats: Option<Vec<InlineFormat>>,
    after_selection: DisplayRange,
    after_affinity: Affinity,
    after_formats: Option<Vec<InlineFormat>>,
    range: SourceRange,
    removed: String,
    inserted: String,
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
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
}

impl EditorSession {
    pub fn open(source: &str) -> Self {
        Self::restore(source, Revision(0))
    }

    /// Starts a recovered session without persistent undo history.
    pub fn restore(source: &str, revision: Revision) -> Self {
        Self {
            source: Rope::from_str(source),
            projection: crate::inline::Projection::new(source),
            revision,
            selection: DisplayRange::default(),
            affinity: Affinity::Forward,
            pending_formats: None,
            undo: Vec::new(),
            redo: Vec::new(),
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
        self.selection = range;
        self.affinity = affinity;
        self.pending_formats = None;
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

    pub(crate) fn check_revision(&self, expected: Revision) -> Result<(), EditorError> {
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

    fn prepare_source(
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
        let start = self.source.byte_to_char(edit.range.start.0);
        let end = self.source.byte_to_char(edit.range.end.0);
        self.source.remove(start..end);
        self.source.insert(start, &edit.inserted);
        let update = self.projection.apply(&self.source, edit);
        self.revision = edit.revision;
        let caret = DisplayOffset(
            self.projection
                .display_at(edit.range.start.0 + edit.inserted.len()),
        );
        self.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        ViewChange {
            previous_revision: edit.previous_revision,
            revision: edit.revision,
            range: update.range,
            inserted: update.inserted,
            selection: self.selection,
            affinity: self.affinity,
            projection: self.projection.query(self.revision, update.semantic_range),
            work: EditWork {
                materialized_source_bytes: edit.removed.len() + update.materialized_source_bytes,
                inserted_bytes: edit.inserted.len(),
                parsed_source_bytes: update.parsed_source_bytes,
            },
        }
    }

    /// `accept` must protect the record against process death before returning
    /// success. A WASM-local success alone cannot provide that acknowledgement.
    /// The exclusive session borrow prevents synchronous acceptance callbacks from
    /// re-entering input; a later native echo must retain its original revision.
    ///
    /// ```compile_fail,E0499
    /// use futo_notes_editor::{DisplayRange, EditorSession, Revision};
    /// let mut session = EditorSession::open("text");
    /// session.replace(Revision(0), DisplayRange::default(), "!", &mut |_| {
    ///     session.select(Revision(0), DisplayRange::default()).unwrap();
    ///     Ok(())
    /// });
    /// ```
    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let affinity = if range == self.selection {
            self.affinity
        } else if range.start.0 == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        };
        let pending = if range == self.selection {
            self.pending_formats.as_deref()
        } else {
            None
        };
        let plan = self
            .projection
            .edit(&self.source, range, inserted, affinity, pending, None)?;
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
        let mut change = self.apply(&edit);
        let caret = DisplayOffset(self.projection.display_at(plan.caret));
        self.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        self.pending_formats = Some(plan.formats);
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        self.undo.push(HistoryEntry {
            before_selection,
            before_affinity,
            before_formats,
            after_selection: self.selection,
            after_affinity: self.affinity,
            after_formats: self.pending_formats.clone(),
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        });
        self.redo.clear();
        Ok(change)
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
        if self.selection.start == self.selection.end {
            let mut formats = self.active_formats();
            if formats.contains(&format) {
                formats.retain(|value| *value != format);
            } else {
                formats.push(format);
                formats.sort();
            }
            self.pending_formats = Some(formats);
            return Ok(None);
        }
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let plan = self.projection.edit(
            &self.source,
            self.selection,
            "",
            self.affinity,
            None,
            Some(format),
        )?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        self.selection = before_selection;
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        self.undo.push(HistoryEntry {
            before_selection,
            before_affinity,
            before_formats,
            after_selection: self.selection,
            after_affinity: self.affinity,
            after_formats: None,
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        });
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
        if self.prepare_source(edit.previous_revision, edit.range, &edit.inserted)? != *edit {
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
        let Some(entry) = (if redo { &self.redo } else { &self.undo }).last() else {
            return Ok(None);
        };
        let (range, inserted) = if redo {
            (entry.range, entry.inserted.as_str())
        } else {
            (
                SourceRange {
                    start: entry.range.start,
                    end: SourceOffset(entry.range.start.0 + entry.inserted.len()),
                },
                entry.removed.as_str(),
            )
        };
        let edit = self.prepare_source(expected, range, inserted)?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        let entry = if redo {
            self.redo.pop().unwrap()
        } else {
            self.undo.pop().unwrap()
        };
        self.selection = if redo {
            entry.after_selection
        } else {
            entry.before_selection
        };
        self.affinity = if redo {
            entry.after_affinity
        } else {
            entry.before_affinity
        };
        change.selection = self.selection;
        change.affinity = self.affinity;
        self.pending_formats = if redo {
            entry.after_formats.clone()
        } else {
            entry.before_formats.clone()
        };
        if redo {
            self.undo.push(entry);
        } else {
            self.redo.push(entry);
        }
        Ok(Some(change))
    }
}
