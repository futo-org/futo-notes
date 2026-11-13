//! Several display replacements a native text control makes as one user
//! action (a correction across formatted runs): one acceptance, one undo
//! step. Each run addresses the display before the action.
use super::super::history::Group;
use super::super::Engine;
use super::{Batch, Change};
use crate::{DisplayRange, EditorError, InputAction, Revision, SourceEdit, ViewChange};

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

impl Engine {
    /// Apply `runs` (ranges in the display before the action, in order and
    /// not overlapping) as one action. Each run is planned as typing over
    /// its range would be, against the text before the action, so unchanged
    /// text between runs keeps its spelling; the caret lands after the last
    /// run's text. Empty, unordered, overlapping or invalid runs refuse
    /// before acceptance; so do several runs while text is marked.
    pub(crate) fn replace_many(
        &mut self,
        expected: Revision,
        runs: &[(DisplayRange, &str)],
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        if let [(range, text)] = runs {
            return self.replace(expected, *range, text, InputAction::Isolated, accept);
        }
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        if runs.is_empty() {
            return Err(EditorError::InvalidRange);
        }
        for (index, (range, _)) in runs.iter().enumerate() {
            self.check_display_range(*range)?;
            if self.touches_metadata(*range) {
                return Err(EditorError::InvalidRange);
            }
            if index > 0 {
                let previous = runs[index - 1].0;
                if previous.end.0 > range.start.0 || previous.start == range.start {
                    return Err(EditorError::InvalidRange);
                }
            }
        }
        let plans: Vec<_> = runs
            .iter()
            .map(|(range, text)| self.plan_input(self.outside_crlf(*range), text))
            .collect();
        if plans
            .windows(2)
            .any(|pair| pair[0].range.end > pair[1].range.start)
        {
            return Err(EditorError::InvalidRange);
        }
        let before = self.point();
        let mut batch = Batch::default();
        // Last first, so each plan's source offsets still hold.
        for plan in plans.iter().rev() {
            batch.work.parsed_source_bytes += plan.parsed;
            self.raw(&mut batch, plan.range.clone(), &plan.inserted);
        }
        let Some((edit, shown, records)) = self.accept(batch, accept)? else {
            return Ok(None);
        };
        let (last, earlier) = plans.split_last().expect("several runs");
        let caret = earlier.iter().fold(last.caret, |caret, plan| {
            caret + plan.inserted.len() - plan.range.len()
        });
        self.caret_at(caret);
        self.typing = None;
        self.history.redo.clear();
        self.history.undo.push(Group {
            records,
            before,
            after: self.point(),
        });
        Ok(Some(self.change(edit, shown)))
    }

    pub(crate) fn replace_many_view(
        &mut self,
        expected: Revision,
        runs: &[(DisplayRange, &str)],
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        Ok(match self.replace_many(expected, runs, accept)? {
            Some(change) => self.view(change),
            None => self.unchanged(),
        })
    }
}
