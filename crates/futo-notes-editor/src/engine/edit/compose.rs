//! Composition: marked text over a pinned display range, committed as one
//! isolated action.
use super::super::history::{Group, Record};
use super::super::Engine;
use super::{Batch, Change};
use crate::history::{typing_kind, TypingRun};
use crate::{DisplayOffset, DisplayRange, EditorError, InputAction, Revision, SourceEdit};

/// Marked text: a provisional overlay on a pinned display range. The note
/// does not change until it commits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Marked {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
}

impl Engine {
    // ---- Composition ----

    pub fn composition(&self) -> Option<&Marked> {
        self.composition.as_ref()
    }

    /// Start or update marked text. Updates keep the opening range.
    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Marked, EditorError> {
        self.check_revision(expected)?;
        let range = match &self.composition {
            Some(marked) => marked.range,
            None => {
                self.check_display_range(range)?;
                let range = if range.start == range.end {
                    self.outside_crlf(range)
                } else {
                    range
                };
                if self.touches_metadata(range) {
                    return Err(EditorError::InvalidRange);
                }
                range
            }
        };
        let marked = Marked {
            revision: expected,
            range,
            text: text.to_owned(),
        };
        self.composition = Some(marked.clone());
        Ok(marked)
    }

    /// Commit marked text (or `text`, when the host changed it at the end)
    /// as one isolated action. A refused acceptance keeps the marked text.
    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        let Some(marked) = self.composition.take() else {
            return Ok(None);
        };
        let text = text.unwrap_or(&marked.text);
        match self.replace(
            expected,
            marked.range,
            text,
            InputAction::CompositionCommit,
            accept,
        ) {
            Ok(change) => Ok(change),
            Err(error) => {
                self.composition = Some(marked);
                Err(error)
            }
        }
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorError> {
        self.check_revision(expected)?;
        self.composition = None;
        Ok(())
    }

    /// Input while marked text is pending addresses the display with the
    /// marked text in place. The marked text commits first, then the input
    /// applies; both go through one acceptance and stay separate undo steps.
    pub(super) fn input_during_composition(
        &mut self,
        range: DisplayRange,
        text: &str,
        action: InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        let marked = self.composition.clone().expect("composition pending");
        let provisional =
            self.display_len() - (marked.range.end.0 - marked.range.start.0) + marked.text.len();
        if range.start.0 > range.end.0 || range.end.0 > provisional {
            return Err(EditorError::InvalidRange);
        }
        let opening = self.point();
        let mut batch = Batch::default();
        // Commit.
        let commit_range = self.outside_crlf(marked.range);
        let commit = self.plan(commit_range, &marked.text);
        self.raw(&mut batch, commit.range.clone(), &commit.inserted);
        let commit_records = batch.records.len();
        let (dstart, dold, dend) = batch.display.expect("commit changed the display");
        // Map the provisional range onto the display after the commit.
        let marked_end = marked.range.start.0 + marked.text.len();
        // Provisional offsets become offsets in the display before the
        // commit, then pass through the commit's display change.
        let map = |at: usize| {
            if at <= marked.range.start.0 {
                return at;
            }
            if at < marked_end {
                return (dstart.max(marked.range.start.0) + at - marked.range.start.0).min(dend);
            }
            let committed = at - marked_end + marked.range.end.0;
            if committed >= dold {
                committed - dold + dend
            } else if committed <= dstart {
                committed
            } else {
                dend
            }
        };
        let saved = self.point();
        self.caret_at(commit.caret);
        let after_commit = self.point();
        let mapped = DisplayRange {
            start: DisplayOffset(map(range.start.0)),
            end: DisplayOffset(map(range.end.0)),
        };
        let valid = self.check_display_range(mapped).is_ok() && !self.touches_metadata(mapped);
        if !valid {
            self.revert(batch);
            self.restore(&saved);
            return Err(EditorError::InvalidRange);
        }
        let input = self.plan(self.outside_crlf(mapped), text);
        self.raw(&mut batch, input.range.clone(), &input.inserted);
        let Some((edit, shown, mut records)) = self.accept(batch, accept).inspect_err(|_| {
            self.restore(&opening);
        })?
        else {
            self.restore(&opening);
            self.composition = None;
            return Ok(None);
        };
        self.composition = None;
        self.caret_at(input.caret);
        let input_records = records.split_off(commit_records);
        // A part that put back what it replaced is no undo step.
        let changes = |records: &[Record]| records.iter().any(|r| r.removed != r.inserted);
        self.history.redo.clear();
        let commit_changed = changes(&records);
        if commit_changed {
            self.history.undo.push(Group {
                records,
                before: opening.clone(),
                after: after_commit.clone(),
            });
        }
        if changes(&input_records) {
            self.history.undo.push(Group {
                records: input_records,
                before: if commit_changed {
                    after_commit
                } else {
                    opening
                },
                after: self.point(),
            });
        }
        let now = self.clock.now();
        let kind = (action == InputAction::Typing)
            .then(|| typing_kind(mapped, text, self.selection))
            .flatten();
        self.typing = kind.map(|kind| TypingRun::new(kind, self.selection, now));
        Ok(Some(self.change(edit, shown)))
    }
}
