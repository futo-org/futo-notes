//! Adopt outside contributions without recording them as local Undo actions.
use super::*;
use crate::history::{SourcePoint, SourceSelection};
use similar::{ChangeTag, TextDiff};
use std::ops::Range;

/// A session- and revision-bound adoption prepared before the store commits merged bytes.
/// The fields are private: callers can only prepare and apply the same plan.
pub struct ExternalSourceAdoption {
    revision: Revision,
    incarnation: u64,
    opening_selection: DisplayRange,
    opening_affinity: Affinity,
    pub(crate) edit: SourceEdit,
    selection: SourceSelection,
    undo: Vec<HistoryGroup>,
    redo: Vec<HistoryGroup>,
    pending: Option<crate::inline::PendingLinks>,
}

impl EditorSession {
    /// Rebase every retained local history entry onto the outside contribution.
    /// Ambiguity declines adoption before either source or history changes.
    pub fn prepare_external_source(
        &self,
        expected: Revision,
        source: &str,
    ) -> Result<ExternalSourceAdoption, EditorError> {
        on_next!(ref self, |_e| Err(EditorError::UnrepresentableFormat));
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        if !self.projection.references_complete {
            return Err(EditorError::UnrepresentableFormat);
        }
        // Saves share the attachment lock. Bound historical reconstruction
        // before any full-source clone/diff; oversized histories retain the
        // persist-or-park behavior rather than monopolizing the input owner.
        let entries = self
            .undo
            .iter()
            .chain(&self.redo)
            .flat_map(|group| &group.entries);
        let (mut count, mut bytes) = (0usize, self.source.len_bytes().max(source.len()));
        for entry in entries {
            count = count.saturating_add(1);
            bytes = bytes
                .saturating_add(entry.removed.len())
                .saturating_add(entry.inserted.len());
        }
        if bytes > 1024 * 1024 || bytes.saturating_mul(count.max(1)) > 16 * 1024 * 1024 {
            return Err(EditorError::UnrepresentableFormat);
        }
        let original = self.source_text();
        let correspondence = Correspondence::new(&original, source);
        let (selection, _) = self.capture_history_selection();
        let selection = correspondence.selection(selection)?;
        let undo = rebase_stack(&self.undo, false, &original, source)?;
        let redo = rebase_stack(&self.redo, true, &original, source)?;
        let pending = correspondence.pending(&self.projection.pending_links(0..original.len()))?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(0),
                end: SourceOffset(original.len()),
            },
            source,
        )?;
        Ok(ExternalSourceAdoption {
            revision: expected,
            incarnation: self.incarnation,
            opening_selection: self.selection,
            opening_affinity: self.affinity,
            edit,
            selection,
            undo,
            redo,
            pending: Some(pending),
        })
    }

    /// Adopt an outside source for a session with no unsaved local draft when
    /// its history cannot be rebased. The retained Undo/Redo stacks are
    /// dropped (the same result as reopening the note) and the selection is
    /// whatever the whole-source replacement leaves. Outside bytes may rewrite
    /// front matter, which local input never may.
    pub fn prepare_external_source_dropping_history(
        &self,
        expected: Revision,
        source: &str,
    ) -> Result<ExternalSourceAdoption, EditorError> {
        on_next!(ref self, |_e| Err(EditorError::UnrepresentableFormat));
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let edit = self.prepare_exact_source(
            expected,
            SourceRange {
                start: SourceOffset(0),
                end: SourceOffset(self.source.len_bytes()),
            },
            source,
        )?;
        Ok(ExternalSourceAdoption {
            revision: expected,
            incarnation: self.incarnation,
            opening_selection: self.selection,
            opening_affinity: self.affinity,
            edit,
            selection: SourceSelection::Derived,
            undo: Vec::new(),
            redo: Vec::new(),
            pending: None,
        })
    }

    /// Apply a prepared adoption after the atomic store commit. No local edit
    /// can interleave while the attachment owner holds its session lock.
    pub fn apply_external_source(
        &mut self,
        adoption: ExternalSourceAdoption,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(adoption.revision)?;
        if adoption.incarnation != self.incarnation
            || adoption.opening_selection != self.selection
            || adoption.opening_affinity != self.affinity
        {
            return Err(EditorError::StaleClaim);
        }
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let mut change = self.apply(&adoption.edit);
        self.selection = self
            .project_history_selection(adoption.selection, self.selection)
            .0;
        if let Some(pending) = &adoption.pending {
            change.work.link_metadata_items += self.projection.restore_pending(pending);
        }
        self.undo = adoption.undo;
        self.redo = adoption.redo;
        self.typing = None;
        change.selection = self.selection;
        change.affinity = self.affinity;
        Ok(change)
    }
}

fn rebase_stack(
    stack: &[HistoryGroup],
    redo: bool,
    original: &str,
    merged: &str,
) -> Result<Vec<HistoryGroup>, EditorError> {
    let mut old = original.to_owned();
    let mut new = merged.to_owned();
    let mut groups = Vec::with_capacity(stack.len());
    for group in stack.iter().rev() {
        let mut entries = Vec::with_capacity(group.entries.len());
        let steps: Box<dyn Iterator<Item = &HistoryEntry>> = if redo {
            Box::new(group.entries.iter())
        } else {
            Box::new(group.entries.iter().rev())
        };
        for step in steps {
            let mut next_old = old.clone();
            if redo {
                next_old.replace_range(step.range.start.0..step.range.end.0, &step.inserted);
            } else {
                next_old.replace_range(
                    step.range.start.0..step.range.start.0 + step.inserted.len(),
                    &step.removed,
                );
            }
            let next_new = match futo_notes_merge::three_way_merge(original, merged, &next_old) {
                futo_notes_merge::MergeResult::Clean(source) => source,
                futo_notes_merge::MergeResult::Conflict => {
                    return Err(EditorError::UnrepresentableFormat)
                }
            };
            let (before, after) = if redo {
                (
                    Correspondence::new(&old, &new),
                    Correspondence::new(&next_old, &next_new),
                )
            } else {
                (
                    Correspondence::new(&next_old, &next_new),
                    Correspondence::new(&old, &new),
                )
            };
            let mapped_range = before
                .copied(step.range.start.0..step.range.end.0)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let mut check = if redo { new.clone() } else { next_new.clone() };
            if check.get(mapped_range.clone()) != Some(step.removed.as_str()) {
                return Err(EditorError::UnrepresentableFormat);
            }
            check.replace_range(mapped_range.clone(), &step.inserted);
            if check != if redo { &next_new } else { &new }.as_str() {
                return Err(EditorError::UnrepresentableFormat);
            }
            entries.push(HistoryEntry {
                range: SourceRange {
                    start: SourceOffset(mapped_range.start),
                    end: SourceOffset(mapped_range.end),
                },
                removed: step.removed.clone(),
                inserted: step.inserted.clone(),
                before_source: before.selection(step.before_source)?,
                after_source: after.selection(step.after_source)?,
                before_selection: step.before_selection,
                after_selection: step.after_selection,
                before_affinity: step.before_affinity,
                after_affinity: step.after_affinity,
                before_formats: step.before_formats.clone(),
                after_formats: step.after_formats.clone(),
                before_links: before.pending(&step.before_links)?,
                after_links: after.pending(&step.after_links)?,
            });
            old = next_old;
            new = next_new;
        }
        if !redo {
            entries.reverse();
        }
        groups.push(HistoryGroup::new(entries));
    }
    groups.reverse();
    Ok(groups)
}

/// Correspondence comes from an established diff implementation. Only equal
/// source bytes may carry transient syntax metadata into another generation.
struct Correspondence {
    equal: Vec<(Range<usize>, Range<usize>)>,
    old_len: usize,
    new_len: usize,
}
impl Correspondence {
    fn new(before: &str, after: &str) -> Self {
        let (mut old, mut new) = (0, 0);
        let mut equal: Vec<(Range<usize>, Range<usize>)> = Vec::new();
        for change in TextDiff::from_chars(before, after).iter_all_changes() {
            let len = change.value().len();
            match change.tag() {
                ChangeTag::Equal => {
                    if let Some((a, z)) = equal
                        .last_mut()
                        .filter(|(a, z)| a.end == old && z.end == new)
                    {
                        a.end += len;
                        z.end += len;
                    } else {
                        equal.push((old..old + len, new..new + len));
                    }
                    old += len;
                    new += len;
                }
                ChangeTag::Delete => old += len,
                ChangeTag::Insert => new += len,
            }
        }
        Self {
            equal,
            old_len: before.len(),
            new_len: after.len(),
        }
    }
    fn point(&self, at: usize) -> usize {
        for (old, new) in &self.equal {
            if old.contains(&at) {
                return new.start + at - old.start;
            }
            if at < old.start {
                return new.start;
            }
        }
        if at == self.old_len {
            self.new_len
        } else {
            self.equal.last().map_or(0, |(_, new)| new.end)
        }
    }
    fn copied(&self, range: Range<usize>) -> Option<Range<usize>> {
        if range.is_empty() {
            let at = self.point(range.start);
            return Some(at..at);
        }
        let start = self.point(range.start);
        let mut at = range.start;
        for (old, new) in &self.equal {
            if old.end <= at {
                continue;
            }
            if old.start > at || new.start + at - old.start != start + at - range.start {
                return None;
            }
            at = old.end.min(range.end);
            if at == range.end {
                return Some(start..start + range.len());
            }
        }
        None
    }
    fn selection(&self, source: SourceSelection) -> Result<SourceSelection, EditorError> {
        let SourceSelection::Exact(mut exact) = source else {
            return Err(EditorError::UnrepresentableFormat);
        };
        for point in [&mut exact.start, &mut exact.end] {
            let atom_survives = point.atom.is_none_or(|atom| {
                self.copied(point.source.0..point.source.0 + atom.source_len)
                    .is_some()
            });
            *point = if atom_survives {
                SourcePoint {
                    source: SourceOffset(self.point(point.source.0)),
                    ..*point
                }
            } else {
                SourcePoint {
                    source: SourceOffset(self.point(point.source.0)),
                    within: 0,
                    atom: None,
                }
            };
        }
        Ok(SourceSelection::Exact(exact))
    }
    fn pending(
        &self,
        pending: &crate::inline::PendingLinks,
    ) -> Result<crate::inline::PendingLinks, EditorError> {
        let window = self.point(pending.window.start)..self.point(pending.window.end);
        pending.map_copied(window, |range| (self.copied(range), 1))
    }
}
