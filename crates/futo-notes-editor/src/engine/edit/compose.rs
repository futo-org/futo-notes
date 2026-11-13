//! Composition: marked text over a pinned display range, committed as one
//! isolated action.
use super::super::history::{Group, Record};
use super::super::Engine;
use super::plan::Plan;
use super::{Batch, Change};
use crate::history::{typing_kind, TypingRun};
use crate::{
    Affinity, DisplayOffset, DisplayRange, EditorError, InputAction, Revision, SourceEdit,
};

/// Marked text: a provisional overlay on a pinned display range. The note
/// does not change until it commits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Marked {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
}

/// An offset in the provisional display, before the commit: a source offset
/// before or after the marked text, or a byte of the marked text.
#[derive(Clone, Copy)]
enum Provisional {
    Before(usize),
    Marked(usize),
    After(usize),
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
        let opening = self.point();
        self.adopt_marked_caret(marked.range);
        match self.replace(
            expected,
            marked.range,
            text,
            InputAction::CompositionCommit,
            accept,
        ) {
            Ok(change) => Ok(change),
            Err(error) => {
                self.restore(&opening);
                self.composition = Some(marked);
                Err(error)
            }
        }
    }

    /// Marked text over a collapsed range elsewhere than the selection is
    /// typing at that caret: the selection moves there first, as a host's
    /// selection would, on the side of hidden marks typing takes there.
    pub(crate) fn adopt_marked_caret(&mut self, range: DisplayRange) {
        if range.start == range.end && range != self.selection {
            self.selection = range;
            self.affinity = if range.start.0 == 0 {
                Affinity::Forward
            } else {
                Affinity::Backward
            };
            self.pin = None;
            self.formats = None;
        }
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorError> {
        self.check_revision(expected)?;
        self.composition = None;
        Ok(())
    }

    /// Input while marked text is pending addresses the display with the
    /// marked text in place. The marked text commits first, then the input
    /// applies as it would with nothing marked (a text service's replacement
    /// keeps what it shares with the display), or, for one explicit `run`, as
    /// typing over its range; both go through one acceptance and stay
    /// separate undo steps.
    pub(super) fn input_during_composition(
        &mut self,
        range: DisplayRange,
        text: &str,
        action: InputAction,
        run: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        let marked = self.composition.clone().expect("composition pending");
        let provisional =
            self.display_len() - (marked.range.end.0 - marked.range.start.0) + marked.text.len();
        if range.start.0 > range.end.0 || range.end.0 > provisional {
            return Err(EditorError::InvalidRange);
        }
        let selection = range.start != range.end;
        let (Some(first), Some(last)) = (
            self.provisional_at(&marked, range.start.0, selection),
            self.provisional_at(&marked, range.end.0, false),
        ) else {
            return Err(EditorError::InvalidRange);
        };
        let opening = self.point();
        self.adopt_marked_caret(marked.range);
        let mut batch = Batch::default();
        // Commit.
        let commit_range = self.outside_crlf(marked.range);
        let commit = self.plan_input(commit_range, &marked.text, InputAction::CompositionCommit);
        self.raw(&mut batch, commit.range.clone(), &commit.inserted);
        let commit_records = batch.records.len();
        let mend = marked.range.end.0;
        let footprint = batch.display.unwrap_or((mend, mend, mend));
        let saved = opening.clone();
        self.caret_at(commit.caret);
        let after_commit = self.point();
        let map = |at, provisional| self.committed_at(&marked, &commit, footprint, at, provisional);
        let mapped = DisplayRange {
            start: DisplayOffset(map(first, range.start.0)),
            end: DisplayOffset(map(last, range.end.0)),
        };
        let valid = self.check_display_range(mapped).is_ok() && !self.touches_metadata(mapped);
        if !valid {
            self.revert(batch);
            self.restore(&saved);
            return Err(EditorError::InvalidRange);
        }
        let mapped_in = self.outside_crlf(mapped);
        let input = if run {
            let flat = self.cell_service_text(mapped, text);
            self.plan(mapped_in, flat.as_deref().unwrap_or(text))
        } else {
            self.plan_input(mapped_in, text, action)
        };
        self.raw(&mut batch, input.range.clone(), &input.inserted);
        let Some((edit, shown, mut records)) = self.accept(batch, accept).inspect_err(|_| {
            self.restore(&opening);
        })?
        else {
            // Nothing changed, but the marked text is committed: the caret
            // finishes after the input, as it would had the text changed.
            self.restore(&opening);
            self.composition = None;
            self.caret_at(input.caret);
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

impl Engine {
    /// Where provisional display offset `at` stands before the commit: a
    /// source offset of the display around the marked text, or a byte of
    /// it. A selection's start (`high`) is its first character, after the
    /// hidden marks before it; its end is the last one's end, before those
    /// after it. `None` when `at` splits a character.
    fn provisional_at(&self, marked: &Marked, at: usize, high: bool) -> Option<Provisional> {
        let (mstart, mend) = (marked.range.start.0, marked.range.end.0);
        let marked_end = mstart + marked.text.len();
        let old = if at < mstart {
            at
        } else if at > marked_end {
            at - marked_end + mend
        } else {
            let byte = at - mstart;
            return marked
                .text
                .is_char_boundary(byte)
                .then_some(Provisional::Marked(byte));
        };
        self.check_display(old).ok()?;
        let (lo, hi) = self.source_bounds(old);
        let source = if high { hi } else { lo };
        Some(if at < mstart {
            Provisional::Before(source)
        } else {
            Provisional::After(source)
        })
    }

    /// The display offset after `commit` of provisional offset `provisional`
    /// (standing at `at`), where the commit changed the display by
    /// `footprint` (start, end before, end now). The commit may hide or show
    /// marks around the marked text. Source around the marked text passes
    /// through the commit's edit. The committed text ends at the caret the
    /// commit leaves (a line break written beside it, as next to a divider,
    /// is outside it): its bytes are the source there when it was written
    /// as given, else the display there when it shows as given (kept
    /// characters keep their hidden marks).
    fn committed_at(
        &self,
        marked: &Marked,
        commit: &Plan,
        (dstart, dold, dend): (usize, usize, usize),
        at: Provisional,
        provisional: usize,
    ) -> usize {
        let (cstart, cend) = (commit.range.start, commit.range.end);
        let written_end = cstart + commit.inserted.len();
        let shift = |at: usize, inside: usize| {
            if at <= cstart {
                at
            } else if at >= cend {
                at - cend + written_end
            } else {
                inside
            }
        };
        let byte = match at {
            Provisional::Before(source) => return self.display_of(shift(source, cstart)),
            Provisional::After(source) => return self.display_of(shift(source, written_end)),
            Provisional::Marked(byte) => byte,
        };
        let len = marked.text.len();
        let caret = commit.caret;
        if let Some(start) = caret.checked_sub(len).filter(|&start| {
            self.check_source(start).is_ok() && self.source_slice(start..caret) == marked.text
        }) {
            return self.display_of(start + byte);
        }
        let text_end = self.selection.start.0;
        if let Some(start) = text_end.checked_sub(len).filter(|&start| {
            self.check_display(start).is_ok() && self.display_slice(start..text_end) == marked.text
        }) {
            return start + byte;
        }
        let mend = marked.range.end.0;
        let after = if mend >= dold {
            mend - dold + dend
        } else if mend <= dstart {
            mend
        } else {
            dend
        };
        if byte < len {
            provisional.min(after)
        } else {
            after
        }
    }
}

impl Engine {
    /// How marked `text` over display `range` draws until it commits: the
    /// text it shares with the display at either end keeps its formats; the
    /// rest is typed text and takes the formats typing there carries (the
    /// caret's carried formats, else those of the first character it
    /// replaces). Offsets are bytes of `text`.
    pub(crate) fn marked_runs(
        &self,
        range: DisplayRange,
        text: &str,
    ) -> Vec<(std::ops::Range<usize>, Vec<crate::InlineFormat>)> {
        let old = self.display_slice(range.start.0..range.end.0);
        let (prefix, suffix) = super::plan::changed_stretch(&old, text);
        let shown = self.projection(self.revision, range);
        let mut runs = Vec::new();
        // Kept text at `old` offsets `from..to` lands at `text` offset `at`.
        let keep = |from: usize, to: usize, at: usize, runs: &mut Vec<_>| {
            for run in &shown.runs {
                // The projection holds whole lines: clip runs to `range`.
                let start = run.range.start.0.saturating_sub(range.start.0).max(from);
                let end = run.range.end.0.saturating_sub(range.start.0).min(to);
                if start < end && !run.formats.is_empty() {
                    runs.push((start - from + at..end - from + at, run.formats.clone()));
                }
            }
        };
        keep(0, prefix, 0, &mut runs);
        let typed = prefix..text.len() - suffix;
        if !typed.is_empty() {
            let formats = if range == self.selection && range.start == range.end {
                self.active_formats()
            } else {
                let (low, high) = self.source_bounds(range.start.0 + prefix);
                self.formats_at(if prefix < old.len() - suffix {
                    high
                } else {
                    low
                })
            };
            if !formats.is_empty() {
                runs.push((typed.clone(), formats));
            }
        }
        keep(old.len() - suffix, old.len(), typed.end, &mut runs);
        runs.sort_by_key(|(range, _)| range.start);
        runs
    }
}
