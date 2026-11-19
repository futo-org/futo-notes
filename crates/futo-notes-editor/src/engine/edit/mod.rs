//! Changing the note: typing, deletion, exact source records, undo and redo,
//! and composition. Every change is text edits applied to the lines, then
//! one host acceptance; a refused acceptance puts the text back.
mod bulk;
mod compose;
mod plan;
mod runs;
mod spans;

use super::code_block::is_opening_fence_end;
use super::command::Edit;
use super::history::{Group, Point, Record};
use super::read::{self, Shown};
use super::{Engine, RowExit};
use crate::history::{typing_kind, TypingRun};
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditWork, EditorError, InputAction,
    Revision, SourceEdit, SourceOffset, SourceRange,
};
use std::ops::Range;

/// One accepted change, as a view applies it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Change {
    pub edit: SourceEdit,
    /// The replaced display range, in the display before the change.
    pub range: DisplayRange,
    pub inserted: String,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    /// The display of every line the change showed again (`Shown::lines`), after it.
    pub lines: Range<usize>,
    pub work: EditWork,
}

pub(crate) use compose::Marked;

/// Edits applied but not yet accepted, and their combined footprint.
#[derive(Default)]
pub(crate) struct Batch {
    pub(crate) records: Vec<Record>,
    /// Start, end in the text before the batch, end in the text now.
    source: Option<(usize, usize, usize)>,
    display: Option<(usize, usize, usize)>,
    /// The display of the lines shown again, in the display now.
    lines: Option<Range<usize>>,
    work: EditWork,
}

/// `lines` (display now) carried through a display edit of `range` that
/// inserted `inserted` bytes, then grown by `shown`.
fn regrow(
    lines: &mut Option<Range<usize>>,
    range: Range<usize>,
    inserted: usize,
    shown: Range<usize>,
) {
    let map = |at: usize| {
        if at <= range.start {
            at
        } else if at >= range.end {
            at - range.len() + inserted
        } else {
            range.start + inserted
        }
    };
    *lines = Some(match lines.take() {
        None => shown,
        Some(old) => map(old.start).min(shown.start)..map(old.end).max(shown.end),
    });
}

fn grow(footprint: &mut Option<(usize, usize, usize)>, range: Range<usize>, inserted: usize) {
    let (a, z) = (range.start, range.end);
    *footprint = Some(match *footprint {
        None => (a, z, a + inserted),
        Some((start, old_end, end)) => (
            start.min(a),
            old_end + z.saturating_sub(end),
            end.max(z) - (z - a) + inserted,
        ),
    });
}

impl Engine {
    /// Apply one text edit to the lines, with no acceptance or history.
    pub(crate) fn raw(&mut self, batch: &mut Batch, range: Range<usize>, inserted: &str) {
        let removed = self.source_slice(range.clone());
        let Shown {
            range: shown,
            inserted: display,
            lines,
            parsed,
            materialized,
        } = read::edit(&mut self.store, range.clone(), inserted);
        batch.work.parsed_source_bytes += parsed;
        batch.work.materialized_source_bytes += materialized + removed.len();
        batch.work.inserted_bytes += inserted.len();
        grow(&mut batch.source, range.clone(), inserted.len());
        regrow(&mut batch.lines, shown.clone(), display.len(), lines);
        // An edit that leaves the display text as it was (marks, markers)
        // must not widen the replaced text: a whole-note format would
        // otherwise report every line between its first and last edit.
        if !(shown.is_empty() && display.is_empty()) {
            grow(&mut batch.display, shown, display.len());
        }
        batch.records.push(Record {
            start: range.start,
            removed,
            inserted: inserted.to_owned(),
        });
    }

    /// Undo a batch's edits without a trace.
    pub(crate) fn revert(&mut self, batch: Batch) {
        let mut scratch = Batch::default();
        for record in batch.records.iter().rev() {
            let range = record.start..record.start + record.inserted.len();
            self.raw(&mut scratch, range, &record.removed);
        }
    }

    /// Accept a batch as one source record, or put the text back.
    pub(crate) fn accept(
        &mut self,
        batch: Batch,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<(SourceEdit, Shown, Vec<Record>)>, EditorError> {
        let work = batch.work;
        let Some((start, old_end, end)) = batch.source else {
            return Ok(None);
        };
        let inserted = self.source_slice(start..end);
        let mut removed = inserted.clone();
        for record in batch.records.iter().rev() {
            let at = record.start - start;
            removed.replace_range(at..at + record.inserted.len(), &record.removed);
        }
        debug_assert_eq!(removed.len(), old_end - start);
        if removed == inserted {
            self.revert(batch);
            return Ok(None);
        }
        let Some(revision) = self.revision.0.checked_add(1).map(Revision) else {
            self.revert(batch);
            return Err(EditorError::RevisionExhausted);
        };
        let edit = SourceEdit {
            previous_revision: self.revision,
            revision,
            range: SourceRange {
                start: SourceOffset(start),
                end: SourceOffset(old_end),
            },
            removed,
            inserted,
        };
        if let Err(error) = accept(&edit) {
            self.revert(batch);
            return Err(EditorError::Persistence(error));
        }
        self.revision = revision;
        let lines = batch.lines.expect("lines shown with the source");
        let (dstart, dold, dend) = batch
            .display
            .unwrap_or((lines.start, lines.start, lines.start));
        self.find.edited(dstart..dold, dend - dstart, revision);
        let shown = Shown {
            range: dstart..dold,
            inserted: self.display_slice(dstart..dend),
            lines,
            parsed: work.parsed_source_bytes,
            materialized: work.materialized_source_bytes + edit.removed.len() + edit.inserted.len(),
        };
        Ok(Some((edit, shown, batch.records)))
    }

    pub(crate) fn point(&self) -> Point {
        Point {
            selection: self.selection,
            affinity: self.affinity,
            formats: self.formats.clone(),
            pin: self.pin,
            block_selected: self.block_selected,
        }
    }

    pub(crate) fn restore(&mut self, point: &Point) {
        self.selection = point.selection;
        self.affinity = point.affinity;
        self.formats = point.formats.clone();
        self.pin = point.pin;
        self.block_selected = point.block_selected;
    }

    /// Put the collapsed caret at source offset `at`, pinned there.
    pub(crate) fn caret_at(&mut self, at: usize) {
        self.block_selected = false;
        let display = DisplayOffset(self.display_of(at));
        self.selection = DisplayRange {
            start: display,
            end: display,
        };
        // A caret never rests inside a CRLF or in metadata, even when an
        // edit lands there.
        let outside = self.outside_metadata(self.outside_crlf(self.selection));
        if outside != self.selection {
            self.selection = outside;
            self.pin = None;
            return;
        }
        let (lo, hi) = self.source_bounds(display.0);
        if at == lo && at != hi {
            self.affinity = Affinity::Backward;
        } else if at == hi && at != lo {
            self.affinity = Affinity::Forward;
        }
        // An edit can leave `at` inside what is now hidden syntax (a link's
        // destination); a caret never stands there, so it takes its display
        // point instead of a pin.
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        let fence_end = is_opening_fence_end(entry, at - before.source);
        let stands = fence_end || entry.allowed(at - before.source);
        self.pin = (fence_end || (lo != hi && lo <= at && at <= hi && stands)).then_some(at);
    }

    pub(crate) fn change(&self, edit: SourceEdit, shown: Shown) -> Change {
        Change {
            edit,
            range: DisplayRange {
                start: DisplayOffset(shown.range.start),
                end: DisplayOffset(shown.range.end),
            },
            inserted: shown.inserted,
            selection: self.selection,
            affinity: self.affinity,
            lines: shown.lines,
            work: EditWork {
                materialized_source_bytes: shown.materialized,
                parsed_source_bytes: shown.parsed,
                ..EditWork::default()
            },
        }
    }

    // ---- Input ----

    /// Replace display `range` with `text`. A typed character always lands.
    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        action: InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.replace_input(expected, range, text, action, false, accept)
    }

    /// `replace`; `run` is one explicit run of `replace_runs`, which commits
    /// marked text and then lands as typing over its range does.
    fn replace_input(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        action: InputAction,
        run: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            // A host that owns its provisional text cannot also commit
            // through the engine's.
            if action == InputAction::CompositionCommit {
                return Err(EditorError::CompositionActive);
            }
            return self.input_during_composition(range, text, action, run, accept);
        }
        self.check_display_range(range)?;
        let range = self.outside_crlf(range);
        if self.touches_metadata(range) {
            return Err(EditorError::InvalidRange);
        }
        let range = self.in_body(range);
        let kind = (action == InputAction::Typing)
            .then(|| typing_kind(range, text, self.selection))
            .flatten();
        let before = self.point();
        let deleted = self.deleted_formats(range, text);
        let plan = self.plan_input(range, text, action);
        let mut batch = Batch::default();
        batch.work.parsed_source_bytes += plan.parsed;
        let typed_line = (action == InputAction::Typing && !text.contains(['\n', '\r']))
            .then(|| self.line_of(plan.range.start))
            .filter(|&index| !self.is_finished_row(index));
        self.raw(&mut batch, plan.range.clone(), &plan.inserted);
        let finished = match typed_line {
            Some(index) => self.finished_row_exit(&mut batch, index),
            None => None,
        };
        let Some((edit, shown, records)) = self.accept(batch, accept)? else {
            // Unchanged input still finishes at the end of its text.
            if range.start != range.end {
                self.caret_at(plan.caret);
            }
            return Ok(None);
        };
        self.caret_at(finished.unwrap_or(plan.caret));
        // The keystroke that finishes a delimiter row is an Undo step of its
        // own; until then typing on the row leaves the caret writing it.
        let kind = kind.filter(|_| finished.is_none());
        self.typed_table = finished.map(|_| RowExit {
            revision: self.revision,
            caret: self.selection,
            before: before.clone(),
            wrote: true,
        });
        self.writing_row =
            (typed_line.is_some() && finished.is_none()).then_some((self.revision, self.selection));
        if plan.carry.is_some() {
            self.formats = plan.carry;
        }
        self.carry_deleted(deleted);
        let now = self.clock.now();
        let continues = kind.is_some_and(|kind| {
            self.typing
                .as_ref()
                .is_some_and(|run| run.continues(kind, range, now))
        });
        let after = self.point();
        self.history.redo.clear();
        match self.history.undo.last_mut() {
            Some(group) if continues => {
                group.records.extend(records);
                group.after = after;
            }
            _ => self.history.undo.push(Group {
                records,
                before,
                after,
            }),
        }
        self.typing = kind.map(|kind| TypingRun::new(kind, self.selection, now));
        Ok(Some(self.change(edit, shown)))
    }

    /// Backspace or Delete: remove the selection, or one visible grapheme.
    pub fn delete(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        let selection = self.selection;
        let range = if selection.start != selection.end {
            selection
        } else {
            self.caret_deletion(selection.start.0, direction)
        };
        if range.start == range.end || self.touches_metadata(range) {
            return Ok(None);
        }
        self.replace(expected, range, "", InputAction::Typing, accept)
    }

    /// Apply an exact source record, as replay and commands do. The caret
    /// lands after the inserted text.
    pub fn edit_source(
        &mut self,
        expected: Revision,
        range: SourceRange,
        text: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        self.check_source(range.start.0)?;
        self.check_source(range.end.0)?;
        let before = self.point();
        let mut batch = Batch::default();
        self.raw(&mut batch, range.start.0..range.end.0, text);
        let Some((edit, shown, records)) = self.accept(batch, accept)? else {
            return Ok(None);
        };
        self.caret_at(range.start.0 + text.len());
        self.typing = None;
        self.history.redo.clear();
        self.history.undo.push(Group {
            records,
            before,
            after: self.point(),
        });
        Ok(Some(self.change(edit, shown)))
    }

    pub fn undo(
        &mut self,
        expected: Revision,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.history_step(expected, false, accept)
    }

    pub fn redo(
        &mut self,
        expected: Revision,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.history_step(expected, true, accept)
    }

    fn history_step(
        &mut self,
        expected: Revision,
        redo: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Ok(None);
        }
        let stack = if redo {
            &self.history.redo
        } else {
            &self.history.undo
        };
        let Some(group) = stack.last().cloned() else {
            return Ok(None);
        };
        let mut batch = Batch::default();
        if redo {
            for record in &group.records {
                let range = record.start..record.start + record.removed.len();
                self.raw(&mut batch, range, &record.inserted);
            }
        } else {
            for record in group.records.iter().rev() {
                let range = record.start..record.start + record.inserted.len();
                self.raw(&mut batch, range, &record.removed);
            }
        }
        let Some((edit, shown, _)) = self.accept(batch, accept)? else {
            return Ok(None);
        };
        let group = if redo {
            self.history.redo.pop()
        } else {
            self.history.undo.pop()
        }
        .expect("the group just applied");
        self.restore(if redo { &group.after } else { &group.before });
        if redo {
            self.history.undo.push(group);
        } else {
            self.history.redo.push(group);
        }
        self.typing = None;
        Ok(Some(self.change(edit, shown)))
    }
}
