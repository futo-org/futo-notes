//! Escapes the engine wrote just before the caret while a run was typed, kept
//! so the input that continues the run may drop the ones no longer needed
//! (`inline::EngineWritten`), and restored with the history state they
//! belong to. Escapes already in the note are never part of a run.
use super::*;
use crate::inline::EngineWritten;

/// Source bytes the engine wrote, ending at the caret, as of `revision`.
#[derive(Clone)]
pub(super) struct WrittenRun {
    revision: Revision,
    start: usize,
    bytes: String,
}

/// The source edit the last applied change made.
pub(super) struct LastEdit {
    previous: Revision,
    revision: Revision,
    start: usize,
    removed_end: usize,
    inserted_end: usize,
    removed_escape: bool,
}

/// What an input started from.
pub(super) struct BeforeInput {
    revision: Revision,
    groups: usize,
    entries: usize,
    run: Option<WrittenRun>,
}

/// A run longer than this is not tracked; the escapes it ends with stay.
const MAX_RUN: usize = 64;

fn has_escape(text: &str) -> bool {
    text.contains("&#") || text.contains('\\')
}

impl EditorSession {
    pub(super) fn note_applied(&mut self, edit: &SourceEdit) {
        self.last_edit = Some(LastEdit {
            previous: edit.previous_revision,
            revision: edit.revision,
            start: edit.range.start.0,
            removed_end: edit.range.end.0,
            inserted_end: edit.range.start.0 + edit.inserted.len(),
            removed_escape: has_escape(&edit.removed),
        });
    }

    pub(super) fn before_input(&self) -> BeforeInput {
        BeforeInput {
            revision: self.revision,
            groups: self.undo.len(),
            entries: self.undo.last().map_or(0, |group| group.entries.len()),
            run: self.written_run.clone(),
        }
    }

    /// Runs `input` first allowed to respell the run that ends at a caret
    /// `range`, then, refused, as it would run without one.
    pub(super) fn continuing_written<T>(
        &mut self,
        range: DisplayRange,
        mut input: impl FnMut(&mut Self) -> Result<T, EditorError>,
    ) -> Result<T, EditorError> {
        if let Some(run) = self.written_at(range) {
            let attempt = {
                let _held = EngineWritten::set(run);
                input(self)
            };
            if !matches!(attempt, Err(EditorError::UnrepresentableFormat)) {
                return attempt;
            }
        }
        input(self)
    }

    fn written_at(&self, range: DisplayRange) -> Option<String> {
        let run = self
            .written_run
            .as_ref()
            .filter(|run| run.revision == self.revision)?;
        if range.start != range.end || self.composition.is_some() {
            return None;
        }
        let (low, high) = self.projection.source_bounds(range.start.0);
        (low..=high)
            .contains(&(run.start + run.bytes.len()))
            .then(|| run.bytes.clone())
    }

    /// After an accepted input: the run its one edit continued or began, also
    /// recorded on the history group the edit joined.
    pub(super) fn track_written(&mut self, before: BeforeInput) {
        let Some(edit) = self
            .last_edit
            .as_ref()
            .filter(|edit| edit.previous == before.revision && edit.revision == self.revision)
        else {
            return;
        };
        let previous = before.run.filter(|run| run.revision == before.revision);
        let run = self.written_after(edit, previous.as_ref());
        let entries = self.undo.last().map_or(0, |group| group.entries.len());
        if self.undo.len() > before.groups {
            self.undo.last_mut().unwrap().written[0] = previous.map(|run| (run.start, run.bytes));
        }
        if self.undo.len() > before.groups || entries > before.entries {
            self.undo.last_mut().unwrap().written[1] =
                run.as_ref().map(|run| (run.start, run.bytes.clone()));
        }
        self.written_run = run;
    }

    fn written_after(&self, edit: &LastEdit, previous: Option<&WrittenRun>) -> Option<WrittenRun> {
        if self.selection.start != self.selection.end {
            return None;
        }
        // The edit is the minimal changed span, so a run it touches stays
        // part of the new run, moved by the edit.
        let moved = |at: usize| {
            if at <= edit.start {
                at
            } else if at >= edit.removed_end {
                at + edit.inserted_end - edit.removed_end
            } else {
                edit.inserted_end
            }
        };
        let (mut start, mut end) = (edit.start, edit.inserted_end);
        match previous.map(|run| (run.start, run.start + run.bytes.len())) {
            Some((low, high)) if low <= edit.removed_end && edit.start <= high => {
                // Bytes the edit replaced beyond the run were the note's own.
                if edit.removed_escape && (edit.start < low || edit.removed_end > high) {
                    return None;
                }
                start = start.min(moved(low));
                end = end.max(moved(high));
            }
            _ if edit.removed_escape => return None,
            _ => {}
        }
        let (low, high) = self.projection.source_bounds(self.selection.start.0);
        if !(low..=high).contains(&end) || end - start > MAX_RUN {
            return None;
        }
        let text = self.source.byte_slice(start..end).to_string();
        let line = text.rfind(['\n', '\r']).map_or(0, |at| at + 1);
        has_escape(&text[line..]).then(|| WrittenRun {
            revision: self.revision,
            start: start + line,
            bytes: text[line..].to_owned(),
        })
    }

    /// The run of the history state undo or redo just restored.
    pub(super) fn restore_written(&mut self, run: &Option<(usize, String)>) {
        self.written_run = run.clone().map(|(start, bytes)| WrittenRun {
            revision: self.revision,
            start,
            bytes,
        });
    }
}
