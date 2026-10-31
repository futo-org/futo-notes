//! Coordinated own-action relinks preserve user actions by applying the same
//! canonical identity mapping to the before/after source of every history group.
//! This explicit lifecycle operation may visit history; it is never a typing path.
use super::*;
use serde::{Deserialize, Serialize};
mod boundary;
mod plan;
mod positions;
mod replay;
mod rewrite;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnActionRelink {
    pub mappings: Vec<(String, String)>,
    /// Note identities immediately before the committed rename/move.
    pub note_ids: Vec<String>,
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
        let Some(prepared) = self.prepare_own_relink(relink)? else {
            return Ok(None);
        };
        let plan::Prepared {
            edit,
            pending,
            selection,
            undo,
            redo,
            work,
        } = prepared;
        // Stage all history and selection work before acceptance. A failed
        // persistence callback changes neither history nor the visible draft.
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        charge(&mut change.work, work);
        self.adopt_stage_pending(&pending, &mut change);
        self.undo = undo;
        self.redo = redo;
        self.selection = selection;
        change.selection = selection;
        change.affinity = self.affinity;
        self.typing = None;
        Ok(Some(change))
    }
}
fn difference(before: &str, after: &str, work: &mut EditWork) -> (SourceRange, String) {
    let mut prefix = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| {
            work.link_metadata_items += 1;
            a == b
        })
        .count();
    while !before.is_char_boundary(prefix) || !after.is_char_boundary(prefix) {
        work.link_metadata_items += 1;
        prefix -= 1;
    }
    let mut suffix = before[prefix..]
        .bytes()
        .rev()
        .zip(after[prefix..].bytes().rev())
        .take_while(|(a, b)| {
            work.link_metadata_items += 1;
            a == b
        })
        .count();
    while !before.is_char_boundary(before.len() - suffix)
        || !after.is_char_boundary(after.len() - suffix)
    {
        work.link_metadata_items += 1;
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

// Planning work never represents an extra accepted insertion.
fn charge(total: &mut EditWork, part: EditWork) {
    total.materialized_source_bytes += part.materialized_source_bytes;
    total.parsed_source_bytes += part.parsed_source_bytes;
    total.link_metadata_items += part.link_metadata_items;
    total.link_copied_bytes += part.link_copied_bytes;
}
