//! An adopted own-action relink is one ordinary isolated edit. The store owns
//! the rewrite; the session only turns its exact bytes into one Undo step.
use super::*;
use crate::history::{ExactSelection, SourcePoint, SourceSelection};
use similar::{ChangeTag, TextDiff};

impl EditorSession {
    /// Replace the source with the store's rewritten bytes as one accepted
    /// edit and one Undo step. Existing history is untouched: older entries are
    /// reachable only after undoing this one restores the exact prior source.
    pub fn apply_own_relink(
        &mut self,
        expected: Revision,
        rewritten: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        on_next!(self, accept, |e, accept| e
            .apply_own_relink(expected, rewritten, accept));
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let original = self.source_text();
        if original == rewritten {
            return Ok(None);
        }
        // A derived body is not the whole note the store rewrote.
        if !self.projection.references_complete {
            return Err(EditorError::UnrepresentableFormat);
        }
        let (start, end) = changed_window(&original, rewritten);
        let inserted = &rewritten[start..rewritten.len() - (original.len() - end)];
        let range = SourceRange {
            start: SourceOffset(start),
            end: SourceOffset(end),
        };
        let edit = self.prepare_source(expected, range, inserted)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let (before_source, before_work) = self.capture_history_selection();
        let before_links = self.projection.pending_for_source_edit(edit.range);
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        if let SourceSelection::Exact(selection) = before_source {
            let changes = TextDiff::from_chars(&original[start..end], inserted)
                .iter_all_changes()
                .map(|change| (change.tag(), change.value().len()))
                .collect::<Vec<_>>();
            let mapped = SourceSelection::Exact(ExactSelection {
                start: map_point(&changes, start, selection.start),
                end: map_point(&changes, start, selection.end),
            });
            let (selection, work) = self.project_history_selection(mapped, self.selection);
            self.selection = selection;
            change.work.link_metadata_items += work;
        }
        self.pending_formats = None;
        self.typing = None;
        change.selection = self.selection;
        change.affinity = self.affinity;
        let (after_source, after_work) = self.capture_history_selection();
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items +=
            before_work + after_work + before_links.work + after_links.work;
        change.work.materialized_source_bytes += original.len() + edit.inserted.len();
        self.undo.push(HistoryGroup::new(vec![HistoryEntry {
            before_source,
            after_source,
            before_selection,
            before_affinity,
            before_formats,
            before_links,
            after_selection: self.selection,
            after_affinity: self.affinity,
            after_formats: None,
            after_links,
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        }]));
        self.redo.clear();
        Ok(Some(change))
    }
}

/// The byte window between the common prefix and suffix, on char boundaries.
fn changed_window(before: &str, after: &str) -> (usize, usize) {
    let mut prefix = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !before.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = before[prefix..]
        .bytes()
        .rev()
        .zip(after[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !before.is_char_boundary(before.len() - suffix) {
        suffix -= 1;
    }
    (prefix, before.len() - suffix)
}

/// Unchanged bytes keep their identity; a point inside replaced text moves to
/// the start of its replacement.
fn map_point(changes: &[(ChangeTag, usize)], start: usize, mut point: SourcePoint) -> SourcePoint {
    let at = point.source.0;
    if at <= start {
        return point;
    }
    let (mut old, mut new) = (start, start);
    for &(tag, len) in changes {
        match tag {
            ChangeTag::Equal if at < old + len => break,
            ChangeTag::Equal => {
                old += len;
                new += len;
            }
            ChangeTag::Delete if at < old + len => {
                return SourcePoint {
                    source: SourceOffset(new),
                    within: 0,
                    atom: None,
                };
            }
            ChangeTag::Delete => old += len,
            ChangeTag::Insert => new += len,
        }
    }
    point.source.0 = new + (at - old);
    point
}
