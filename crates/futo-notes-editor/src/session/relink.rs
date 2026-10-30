//! Coordinated own-action relinks preserve user actions by applying the same
//! canonical identity mapping to the before/after source of every history group.
//! This explicit lifecycle operation may visit history; it is never a typing path.
use super::*;
use serde::{Deserialize, Serialize};
mod positions;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnActionRelink {
    pub mappings: Vec<(String, String)>,
    /// Note identities immediately before the committed rename/move.
    pub note_ids: Vec<String>,
}
impl OwnActionRelink {
    fn rewrite(&self, source: &str) -> String {
        let mut ids = self.note_ids.clone();
        let mut source = source.to_owned();
        for (from, to) in &self.mappings {
            source = futo_notes_wikilinks::rewrite_wikilinks(&source, from, to, &ids).0;
            if let Some(id) = ids.iter_mut().find(|id| *id == from) {
                *id = to.clone();
            }
        }
        source
    }
}
impl EditorSession {
    /// Apply only a successful own-action disk relink whose exact pre-relink
    /// source still equals this accepted source. A caller must keep the dirty
    /// draft/history untouched when that conditional adoption does not hold.
    /// No new Undo step is added; user groups and preexisting Redo survive.
    pub fn apply_own_relink(
        &mut self,
        expected: Revision,
        relink: &OwnActionRelink,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let source = self.source_text();
        let rewritten = relink.rewrite(&source);
        if source == rewritten {
            return Ok(None);
        }
        let undo = transform_groups(&source, &self.undo, false, relink)?;
        let redo = transform_groups(&source, &self.redo, true, relink)?;
        let selection = positions::selection(&source, &rewritten, self.selection, self.affinity);
        let (range, inserted) = difference(&source, &rewritten);
        let edit = self.prepare_source(expected, range, &inserted)?;
        // Stage all history and selection work before acceptance. A failed
        // persistence callback changes neither history nor the visible draft.
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        self.undo = undo;
        self.redo = redo;
        self.selection = selection;
        change.selection = selection;
        change.affinity = self.affinity;
        self.typing = None;
        Ok(Some(change))
    }
}
fn transform_groups(
    source: &str,
    groups: &[HistoryGroup],
    redo: bool,
    relink: &OwnActionRelink,
) -> Result<Vec<HistoryGroup>, EditorError> {
    let mut current = source.to_owned();
    let mut transformed = Vec::with_capacity(groups.len());
    for group in groups.iter().rev() {
        let first = group.entries.first().ok_or(EditorError::RecoveryMismatch)?;
        let last = group.entries.last().unwrap();
        let mut other = current.clone();
        let entries: Box<dyn Iterator<Item = &HistoryEntry>> = if redo {
            Box::new(group.entries.iter())
        } else {
            Box::new(group.entries.iter().rev())
        };
        for step in entries {
            let (expected, inserted) = if redo {
                (&step.removed, &step.inserted)
            } else {
                (&step.inserted, &step.removed)
            };
            let range = step.range.start.0..step.range.start.0 + expected.len();
            if other.get(range.clone()) != Some(expected.as_str()) {
                return Err(EditorError::RecoveryMismatch);
            }
            other.replace_range(range, inserted);
        }
        let (before, after) = if redo {
            (&current, &other)
        } else {
            (&other, &current)
        };
        let before_rewritten = relink.rewrite(before);
        let after_rewritten = relink.rewrite(after);
        let (range, inserted) = difference(&before_rewritten, &after_rewritten);
        let entry = HistoryEntry {
            before_source: positions::source_anchor(
                before,
                &before_rewritten,
                first.before_source,
                first.before_affinity,
            ),
            after_source: positions::source_anchor(
                after,
                &after_rewritten,
                last.after_source,
                last.after_affinity,
            ),
            before_selection: positions::selection(
                before,
                &before_rewritten,
                first.before_selection,
                first.before_affinity,
            ),
            before_affinity: first.before_affinity,
            before_formats: first.before_formats.clone(),
            before_links: positions::pending(before, &before_rewritten, &first.before_links),
            after_selection: positions::selection(
                after,
                &after_rewritten,
                last.after_selection,
                last.after_affinity,
            ),
            after_affinity: last.after_affinity,
            after_formats: last.after_formats.clone(),
            after_links: positions::pending(after, &after_rewritten, &last.after_links),
            removed: before_rewritten[range.start.0..range.end.0].to_owned(),
            inserted,
            range,
        };
        transformed.push(HistoryGroup {
            entries: vec![entry],
        });
        current = other;
    }
    transformed.reverse();
    Ok(transformed)
}
fn difference(before: &str, after: &str) -> (SourceRange, String) {
    let mut prefix = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !before.is_char_boundary(prefix) || !after.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = before[prefix..]
        .bytes()
        .rev()
        .zip(after[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !before.is_char_boundary(before.len() - suffix)
        || !after.is_char_boundary(after.len() - suffix)
    {
        suffix -= 1;
    }
    (
        SourceRange {
            start: SourceOffset(prefix),
            end: SourceOffset(before.len() - suffix),
        },
        after[prefix..after.len() - suffix].to_owned(),
    )
}
