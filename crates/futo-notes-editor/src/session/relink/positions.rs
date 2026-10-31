//! Selections follow unchanged scalar runs. Inside replaced bytes, affinity
//! chooses the corresponding edge; endpoints of a replacement retain their side.
use super::*;
use similar::{ChangeTag, TextDiff};

pub(super) fn selection(
    before: &str,
    after: &str,
    range: DisplayRange,
    affinity: Affinity,
) -> DisplayRange {
    if before == after {
        return range;
    }
    let old = crate::inline::Projection::new(before);
    let new = crate::inline::Projection::new(after);
    let runs = changed_runs(before, after);
    let map = |offset: DisplayOffset| {
        let (low, high) = old.source_bounds(offset.0);
        let source = if affinity == Affinity::Forward {
            high
        } else {
            low
        };
        DisplayOffset(new.display_at(source_position(source, affinity, &runs)))
    };
    DisplayRange {
        start: map(range.start),
        end: map(range.end),
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
fn source_position(offset: usize, affinity: Affinity, runs: &[Run]) -> usize {
    let mut before = 0;
    let mut after = 0;
    for run in runs {
        if offset < run.start {
            return after + offset - before;
        }
        after += run.start - before;
        if offset == run.start && run.start < run.end {
            return after;
        }
        if offset < run.end {
            return after
                + if affinity == Affinity::Forward {
                    run.inserted
                } else {
                    0
                };
        }
        if offset == run.start && affinity == Affinity::Backward {
            return after;
        }
        after += run.inserted;
        if offset == run.end {
            return after;
        }
        before = run.end;
    }
    after + offset - before
}

pub(super) fn pending(
    before: &str,
    after: &str,
    snapshot: &crate::inline::PendingLinks,
) -> Result<crate::inline::PendingLinks, EditorError> {
    if !snapshot.guarded_words.is_empty() {
        // This historical source is rewritten by the canonical relinker, but
        // that owner currently returns no retained-source witnesses. TextDiff
        // equality cannot prove guard lineage through a changed generation.
        if before != after {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut same = snapshot.clone();
        same.work += 5 * snapshot.guarded_words.len();
        return Ok(same);
    }
    let runs = changed_runs(before, after);
    let map = |range: &std::ops::Range<usize>| {
        source_position(range.start, Affinity::Backward, &runs)
            ..source_position(range.end, Affinity::Forward, &runs)
    };
    Ok(crate::inline::PendingLinks {
        window: map(&snapshot.window),
        ranges: snapshot.ranges.iter().map(map).collect(),
        delimiters: snapshot.delimiters.iter().map(map).collect(),
        guarded_words: Vec::new(),
        work: snapshot.work,
    })
}

pub(super) fn source_anchor(
    before: &str,
    after: &str,
    anchor: crate::history::SourceSelection,
    affinity: Affinity,
) -> Result<crate::history::SourceSelection, EditorError> {
    match anchor {
        crate::history::SourceSelection::Exact(range) => {
            let runs = changed_runs(before, after);
            let map = |mut point: crate::history::SourcePoint| {
                if let Some(atom) = point.atom {
                    let end = point.source.0 + atom.source_len;
                    if runs.iter().any(|run| {
                        point.source.0 < run.end && run.start < end
                            || run.start == run.end && point.source.0 < run.start && run.start < end
                    }) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                point.source.0 = source_position(point.source.0, affinity, &runs);
                Ok(point)
            };
            Ok(crate::history::SourceSelection::Exact(
                crate::history::ExactSelection {
                    start: map(range.start)?,
                    end: map(range.end)?,
                },
            ))
        }
        crate::history::SourceSelection::Derived => Ok(crate::history::SourceSelection::Derived),
    }
}
