//! Semantic plain-caret policy inside one certified rewritten target.
//! These runs never certify source lineage or transport a nonidentity atom.
use super::*;
use similar::{ChangeTag, TextDiff};

/// Semantic caret policy for ONE already certified emitted target. This is
/// never copied-source evidence and cannot map fields or nonidentity atoms.
pub(super) struct TargetCaret {
    runs: Vec<Run>,
}
impl TargetCaret {
    pub fn new(before: &str, after: &str) -> (Self, usize) {
        let runs = changed_runs(before, after);
        let work = before.len() + after.len() + 3 * runs.len();
        (Self { runs }, work)
    }
    pub fn map(&self, offset: usize, affinity: Affinity) -> (usize, usize) {
        source_position_work(offset, affinity, &self.runs)
    }
}

struct Run {
    start: usize,
    end: usize,
    inserted: usize,
}
fn changed_runs(before: &str, after: &str) -> Vec<Run> {
    let diff = TextDiff::from_chars(before, after);
    let mut source = 0;
    let mut current: Option<Run> = None;
    let mut runs = Vec::new();
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                if let Some(run) = current.take() {
                    runs.push(run);
                }
                source += change.value().len();
            }
            tag => {
                let run = current.get_or_insert(Run {
                    start: source,
                    end: source,
                    inserted: 0,
                });
                if tag == ChangeTag::Delete {
                    source += change.value().len();
                    run.end = source;
                } else {
                    run.inserted += change.value().len();
                }
            }
        }
    }
    if let Some(run) = current {
        runs.push(run);
    }
    runs
}
fn source_position_work(offset: usize, affinity: Affinity, runs: &[Run]) -> (usize, usize) {
    let mut work = 0;
    let mut before = 0;
    let mut after = 0;
    for run in runs {
        work += 1;
        if offset < run.start {
            return (after + offset - before, work);
        }
        after += run.start - before;
        if offset == run.start && run.start < run.end {
            return (after, work);
        }
        if offset < run.end {
            return (
                after
                    + if affinity == Affinity::Forward {
                        run.inserted
                    } else {
                        0
                    },
                work,
            );
        }
        if offset == run.start && affinity == Affinity::Backward {
            return (after, work);
        }
        after += run.inserted;
        if offset == run.end {
            return (after, work);
        }
        before = run.end;
    }
    (after + offset - before, work)
}
