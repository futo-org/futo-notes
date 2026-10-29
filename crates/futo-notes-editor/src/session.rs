use ropey::Rope;

use crate::{
    DisplayOffset, DisplayRange, EditWork, EditorError, Revision, SourceEdit, SourceOffset,
    SourceRange, ViewChange,
};

struct HistoryEntry {
    range: DisplayRange,
    removed: String,
    inserted: String,
}

/// An exact-source plain-text session. Markdown interpretation is added in later
/// slices; hosts must not use this surface as a replacement shipping renderer.
pub struct EditorSession {
    source: Rope,
    revision: Revision,
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
            revision,
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
        self.source.to_string()
    }

    fn char_index(&self, offset: DisplayOffset) -> Result<usize, EditorError> {
        let index = self
            .source
            .try_byte_to_char(offset.0)
            .map_err(|_| EditorError::InvalidRange)?;
        if self.source.char_to_byte(index) != offset.0 {
            return Err(EditorError::InvalidRange);
        }
        Ok(index)
    }

    fn prepare(
        &self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<SourceEdit, EditorError> {
        if expected != self.revision {
            return Err(EditorError::StaleRevision {
                expected,
                actual: self.revision,
            });
        }
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        let start = self.char_index(range.start)?;
        let end = self.char_index(range.end)?;
        Ok(SourceEdit {
            previous_revision: self.revision,
            revision: Revision(
                self.revision
                    .0
                    .checked_add(1)
                    .ok_or(EditorError::RevisionExhausted)?,
            ),
            range: SourceRange {
                start: SourceOffset(range.start.0),
                end: SourceOffset(range.end.0),
            },
            removed: self.source.slice(start..end).to_string(),
            inserted: inserted.to_owned(),
        })
    }

    fn apply(&mut self, edit: &SourceEdit) -> ViewChange {
        let start = self.source.byte_to_char(edit.range.start.0);
        let end = self.source.byte_to_char(edit.range.end.0);
        self.source.remove(start..end);
        self.source.insert(start, &edit.inserted);
        self.revision = edit.revision;
        let caret = DisplayOffset(edit.range.start.0 + edit.inserted.len());
        ViewChange {
            previous_revision: edit.previous_revision,
            revision: edit.revision,
            range: DisplayRange {
                start: DisplayOffset(edit.range.start.0),
                end: DisplayOffset(edit.range.end.0),
            },
            inserted: edit.inserted.clone(),
            selection: DisplayRange {
                start: caret,
                end: caret,
            },
            work: EditWork {
                materialized_source_bytes: edit.removed.len(),
                inserted_bytes: edit.inserted.len(),
            },
        }
    }

    /// `accept` must protect the record against process death before returning
    /// success. A WASM-local success alone cannot provide that acknowledgement.
    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let edit = self.prepare(expected, range, inserted)?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let change = self.apply(&edit);
        self.undo.push(HistoryEntry {
            range,
            removed: edit.removed,
            inserted: edit.inserted,
        });
        self.redo.clear();
        Ok(change)
    }

    /// Replay accepts only a record that matches both revision and exact bytes.
    pub fn replay(&mut self, edit: &SourceEdit) -> Result<ViewChange, EditorError> {
        let range = DisplayRange {
            start: DisplayOffset(edit.range.start.0),
            end: DisplayOffset(edit.range.end.0),
        };
        if self.prepare(edit.previous_revision, range, &edit.inserted)? != *edit {
            return Err(EditorError::RecoveryMismatch);
        }
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
        if expected != self.revision {
            return Err(EditorError::StaleRevision {
                expected,
                actual: self.revision,
            });
        }
        let Some(entry) = (if redo { &self.redo } else { &self.undo }).last() else {
            return Ok(None);
        };
        let (range, inserted) = if redo {
            (entry.range, entry.inserted.as_str())
        } else {
            (
                DisplayRange {
                    start: entry.range.start,
                    end: DisplayOffset(entry.range.start.0 + entry.inserted.len()),
                },
                entry.removed.as_str(),
            )
        };
        let edit = self.prepare(expected, range, inserted)?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        let entry = if redo {
            self.redo.pop().unwrap()
        } else {
            self.undo.pop().unwrap()
        };
        if redo {
            self.undo.push(entry);
        } else {
            change.selection = entry.range;
            self.redo.push(entry);
        }
        Ok(Some(change))
    }
}
