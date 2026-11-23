//! Rebasing the undo and redo stacks onto an outside change.
use super::super::edit::Batch;
use super::super::history::{Group, Point, Record};
use super::super::Engine;
use super::other_lines::on_other_lines;
use super::Map;
use crate::EditorError;
use futo_notes_merge::{three_way_merge, MergeResult};

/// Rebase one stack onto the outside contribution. Undo walks back from the
/// current text, redo forward from it, each step moving by position past an
/// outside change on other lines, or else merging that historical text with
/// it. Two scratch cores follow the walk, one on
/// the local texts and one on the rebased texts, so each group's points are
/// shown in the text they belong to.
pub(super) fn rebase(
    stack: &[Group],
    redo: bool,
    original: &str,
    merged: &str,
) -> Result<Vec<Group>, EditorError> {
    if stack.is_empty() {
        return Ok(Vec::new());
    }
    let mut walk = Walk {
        old: Engine::open(original),
        new: Engine::open(merged),
        old_text: original.to_owned(),
        new_text: merged.to_owned(),
        map: Map::new(original, merged, usize::MAX),
        original,
        merged,
    };
    let mut groups = Vec::with_capacity(stack.len());
    for group in stack.iter().rev() {
        let (first, last) = if redo {
            (&group.before, &group.after)
        } else {
            (&group.after, &group.before)
        };
        let first = walk.point(first);
        let mut records = Vec::with_capacity(group.records.len());
        if redo {
            for record in &group.records {
                records.push(walk.step(record, true)?);
            }
        } else {
            for record in group.records.iter().rev() {
                records.push(walk.step(record, false)?);
            }
            records.reverse();
        }
        let last = walk.point(last);
        let (before, after) = if redo { (first, last) } else { (last, first) };
        groups.push(Group {
            records,
            before,
            after,
        });
    }
    groups.reverse();
    Ok(groups)
}

struct Walk<'a> {
    /// The local historical text, and the same text with the outside change.
    old: Engine,
    new: Engine,
    old_text: String,
    new_text: String,
    map: Map,
    original: &'a str,
    merged: &'a str,
}

impl Walk<'_> {
    fn point(&self, point: &Point) -> Point {
        self.new.shown(&self.old.mark(point).through(&self.map))
    }

    /// Step over `record` (forward for redo, backward for undo) and return
    /// it rebased.
    fn step(&mut self, record: &Record, redo: bool) -> Result<Record, EditorError> {
        let refuse = || EditorError::UnrepresentableFormat;
        let (from, to) = if redo {
            (&record.removed, &record.inserted)
        } else {
            (&record.inserted, &record.removed)
        };
        let mut next_old = self.old_text.clone();
        let range = record.start..record.start + from.len();
        if next_old.get(range.clone()) != Some(from.as_str()) {
            return Err(refuse());
        }
        next_old.replace_range(range.clone(), to);
        let (next_new, next_map, start) =
            match on_other_lines(&self.old_text, &self.new_text, range.clone(), to) {
                Some((next_new, start)) => {
                    let next_map = Map::new(&next_old, &next_new, usize::MAX);
                    (next_new, next_map, start)
                }
                None => {
                    let MergeResult::Clean(next_new) =
                        three_way_merge(self.original, self.merged, &next_old)
                    else {
                        return Err(refuse());
                    };
                    let next_map = Map::new(&next_old, &next_new, usize::MAX);
                    // The record must stand on bytes the rebased copy of the
                    // text before it keeps.
                    let map = if redo { &self.map } else { &next_map };
                    let start = map
                        .copied(record.start..record.start + record.removed.len())
                        .ok_or_else(refuse)?;
                    (next_new, next_map, start)
                }
            };
        // The record was made against the text before it: it must turn that
        // text's rebased copy into the rebased text after it, exactly.
        let (before, after) = if redo {
            (&self.new_text, &next_new)
        } else {
            (&next_new, &self.new_text)
        };
        if !applies(before, start, &record.removed, &record.inserted, after) {
            return Err(refuse());
        }
        let mut scratch = Batch::default();
        self.old.raw(&mut scratch, range, to);
        let mut scratch = Batch::default();
        self.new.raw(&mut scratch, start..start + from.len(), to);
        self.old_text = next_old;
        self.new_text = next_new;
        self.map = next_map;
        Ok(Record {
            start,
            removed: record.removed.clone(),
            inserted: record.inserted.clone(),
        })
    }
}

/// Whether replacing `removed` at `start` in `before` with `inserted` gives
/// exactly `after`.
fn applies(before: &str, start: usize, removed: &str, inserted: &str, after: &str) -> bool {
    let end = start + removed.len();
    before.get(start..end) == Some(removed)
        && after.len() + removed.len() == before.len() + inserted.len()
        && after.get(..start) == before.get(..start)
        && after.get(start..start + inserted.len()) == Some(inserted)
        && after.get(start + inserted.len()..) == before.get(end..)
}
