//! A text service's replacement planned stretch by stretch, so the source
//! between the words it corrects stays as it was.
use super::super::command::{Command, Edit};
use super::super::Engine;
use super::plan::Plan;
use super::Change;
use crate::{
    DisplayOffset, DisplayRange, DisplayReplacement, EditorError, InputAction, Revision, SourceEdit,
};
use std::ops::Range;

impl Engine {
    /// Replace several display ranges as one action (a text service
    /// correcting separate words). The ranges ascend and do not overlap and
    /// address the display with any marked text in place, which commits
    /// first as its own undo step. Each replacement keeps what it shares
    /// with the text it replaces; the caret ends after the last one.
    pub fn replace_runs(
        &mut self,
        expected: Revision,
        runs: &[DisplayReplacement],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        let ordered = runs.iter().all(|run| run.range.start.0 <= run.range.end.0)
            && runs.windows(2).all(|pair| {
                pair[0].range.end.0 <= pair[1].range.start.0
                    && pair[0].range.start != pair[1].range.start
            });
        match runs {
            [] => return Err(EditorError::InvalidRange),
            [one] => {
                return self.replace_input(
                    expected,
                    one.range,
                    &one.inserted,
                    InputAction::Isolated,
                    true,
                    accept,
                )
            }
            _ if !ordered => return Err(EditorError::InvalidRange),
            _ => {}
        }
        self.run(
            expected,
            |engine| {
                let mut plans = Vec::new();
                for run in runs {
                    engine.check_display_range(run.range)?;
                    let range = engine.outside_crlf(run.range);
                    if engine.touches_metadata(range) {
                        return Err(EditorError::InvalidRange);
                    }
                    plans.push(engine.plan_input(range, &run.inserted, InputAction::Isolated));
                }
                let (last, earlier) = plans.split_last().expect("two or more runs");
                let growth: isize = earlier
                    .iter()
                    .map(|plan| plan.inserted.len() as isize - plan.range.len() as isize)
                    .sum();
                let caret = (last.caret as isize + growth) as usize;
                let lines =
                    engine.line_of(plans[0].range.start)..engine.line_of(last.range.end) + 1;
                let edits = plans
                    .iter()
                    .map(|plan| Edit::new(plan.range.clone(), plan.inserted.clone()))
                    .collect();
                let mut command = Command::new(edits, lines, caret..caret);
                command.typed = true;
                let last = &runs[runs.len() - 1];
                command.carry = engine.deleted_formats(last.range, &last.inserted);
                Ok(Some(command))
            },
            accept,
        )
    }

    /// A text service's replacement of display `range` (showing `old`)
    /// with `text`: each separate stretch that differs is replaced on its
    /// own, so the source between corrected words (hidden marks included)
    /// stays as it was. One plan spans them all; the caret ends after the
    /// whole of `text`.
    pub(super) fn plan_runs(&self, range: DisplayRange, old: &str, text: &str) -> Plan {
        let byte = |text: &str| -> Vec<usize> {
            text.char_indices()
                .map(|(at, _)| at)
                .chain([text.len()])
                .collect()
        };
        let (old_at, new_at) = (byte(old), byte(text));
        let old_chars: Vec<char> = old.chars().collect();
        let new_chars: Vec<char> = text.chars().collect();
        let mut stretches: Vec<(Range<usize>, Range<usize>)> = Vec::new();
        for op in similar::capture_diff_slices(similar::Algorithm::Myers, &old_chars, &new_chars) {
            let (tag, from, to) = op.as_tag_tuple();
            if tag == similar::DiffTag::Equal {
                continue;
            }
            let from = old_at[from.start]..old_at[from.end];
            let to = new_at[to.start]..new_at[to.end];
            match stretches.last_mut() {
                Some((was, now)) if was.end == from.start && now.end == to.start => {
                    was.end = from.end;
                    now.end = to.end;
                }
                _ => stretches.push((from, to)),
            }
        }
        let end = self.source_bounds(range.end.0).0;
        if stretches.is_empty() {
            return Plan {
                range: end..end,
                inserted: String::new(),
                caret: end,
                parsed: 0,
                carry: None,
            };
        }
        let plan_stretch = |from: &Range<usize>, to: &Range<usize>| {
            let stretch = DisplayRange {
                start: DisplayOffset(range.start.0 + from.start),
                end: DisplayOffset(range.start.0 + from.end),
            };
            let inserted = &text[to.clone()];
            let at = self.source_bounds(stretch.start.0).0;
            if stretch.start == stretch.end
                && self.empty_line(stretch.start.0).is_none()
                && !self.quote_space(at, inserted)
            {
                Plan {
                    range: at..at,
                    inserted: inserted.to_owned(),
                    caret: at + inserted.len(),
                    parsed: 0,
                    carry: None,
                }
            } else {
                self.plan(stretch, inserted)
            }
        };
        // Stretches whose edits meet in the source (one reaches past the
        // next, as a fence line a joined line moves does) are one stretch,
        // so the source outside them stays as it was.
        type Planned = Vec<(Range<usize>, Range<usize>, Plan)>;
        let push = |planned: &mut Planned, mut from: Range<usize>, mut to: Range<usize>| {
            let mut plan = plan_stretch(&from, &to);
            while let Some((was, now, before)) = planned.last() {
                if plan.range.start >= before.range.end {
                    break;
                }
                from = was.start..from.end;
                to = now.start..to.end;
                planned.pop();
                plan = plan_stretch(&from, &to);
            }
            planned.push((from, to, plan));
        };
        let mut planned: Planned = Vec::new();
        for (from, to) in stretches {
            push(&mut planned, from, to);
        }
        let (from, to, last) = planned.last().expect("a stretch");
        if last.range.end > end && (from.end, to.end) != (old.len(), text.len()) {
            // The last edit reaches past the kept end (a code fence it
            // moves): it replaces through the range's end instead.
            let (from, to) = (from.start..old.len(), to.start..text.len());
            planned.pop();
            push(&mut planned, from, to);
        }
        let (from, to, _) = planned.last().expect("a stretch");
        let reaches_end = (from.end, to.end) == (old.len(), text.len());
        let plans: Vec<Plan> = planned.into_iter().map(|(_, _, plan)| plan).collect();
        let start = plans[0].range.start;
        let stop = plans[plans.len() - 1].range.end;
        let mut inserted = String::new();
        let mut at = start;
        for plan in &plans {
            inserted.push_str(&self.source_slice(at..plan.range.start));
            inserted.push_str(&plan.inserted);
            at = plan.range.end;
        }
        let growth = inserted.len() as isize - (stop - start) as isize;
        let last_plan = &plans[plans.len() - 1];
        let caret = if reaches_end {
            (last_plan.caret as isize + growth
                - (last_plan.inserted.len() as isize - last_plan.range.len() as isize))
                as usize
        } else {
            (end as isize + growth) as usize
        };
        Plan {
            range: start..stop,
            inserted,
            caret,
            parsed: plans.iter().map(|plan| plan.parsed).sum(),
            carry: None,
        }
    }
}

/// How many bytes `old` and `new` share at the start, and then at the end:
/// the stretch between is what a commit replaces.
pub(crate) fn changed_stretch(old: &str, new: &str) -> (usize, usize) {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = old[prefix..]
        .bytes()
        .rev()
        .zip(new[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    (prefix, suffix)
}
