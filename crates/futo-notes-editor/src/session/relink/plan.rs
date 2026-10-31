//! Replay prepares every historical boundary before the one real relink append.
use super::boundary::{Boundary, MappedSide, Side};
use super::*;
use std::sync::Arc;

pub(super) struct Prepared {
    pub edit: SourceEdit,
    pub pending: crate::inline::PendingLinks,
    pub selection: DisplayRange,
    pub undo: Vec<HistoryGroup>,
    pub redo: Vec<HistoryGroup>,
    pub work: EditWork,
}
impl EditorSession {
    pub(super) fn prepare_own_relink(
        &self,
        relink: &OwnActionRelink,
    ) -> Result<Option<Prepared>, EditorError> {
        let original = self.source_text();
        let rewrite = rewrite::Rewrite::prepare(&original, relink)?;
        if original == rewrite.source {
            return Ok(None);
        }
        // Public attachments are canonical roots. A derived body's missing
        // origin is not recovered by treating its bytes as another root.
        if !self.projection.references_complete {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut work = EditWork::default();
        work.materialized_source_bytes += original.len();
        let (range, inserted) = difference(&original, &rewrite.source, &mut work);
        work.materialized_source_bytes += inserted.len();
        let live_pending = self.projection.pending_for_source_edit(range);
        work.link_metadata_items += live_pending.work;
        let (live_anchor, visits) = self.capture_history_selection();
        work.link_metadata_items += visits;
        let mut sides = vec![Side {
            source: live_anchor,
            selection: self.selection,
            affinity: self.affinity,
            pending: &live_pending,
        }];
        work.link_metadata_items += 1;
        let undo_index = if let Some(group) = self.undo.last() {
            sides.push(Side::after(
                group.entries.last().ok_or(EditorError::RecoveryMismatch)?,
            ));
            1
        } else {
            0
        };
        let redo_index = if let Some(group) = self.redo.last() {
            let index = sides.len();
            sides.push(Side::before(
                group.entries.first().ok_or(EditorError::RecoveryMismatch)?,
            ));
            index
        } else {
            0
        };
        let mut replay = replay::Replay::new(self, &original)?;
        let mut identities = transformed::Identities::default();
        let live = Arc::new(Boundary::prepare(
            &mut replay,
            &original,
            rewrite,
            &sides,
            &mut identities,
        )?);
        charge(&mut work, live.work);
        work.link_metadata_items += 1;
        let mut current = live.clone();
        work.link_metadata_items += 1;
        let mut current_side = undo_index;
        let mut undo = Vec::with_capacity(self.undo.len());
        work.link_metadata_items += usize::from(!self.undo.is_empty());
        for (index, group) in self.undo.iter().enumerate().rev() {
            let first = group.entries.first().ok_or(EditorError::RecoveryMismatch)?;
            let last = group.entries.last().unwrap();
            for entry in group.entries.iter().rev() {
                replay.step(entry, false)?;
            }
            let source = replay.session.source_text();
            work.materialized_source_bytes += source.len();
            let rewrite = rewrite::Rewrite::prepare(&source, relink)?;
            let mut sides = vec![Side::before(first)];
            work.link_metadata_items += 1;
            if index > 0 {
                let older = self.undo[index - 1]
                    .entries
                    .last()
                    .ok_or(EditorError::RecoveryMismatch)?;
                sides.push(Side::after(older));
                work.link_metadata_items += 1;
            }
            let before = Arc::new(Boundary::prepare(
                &mut replay,
                &source,
                rewrite,
                &sides,
                &mut identities,
            )?);
            charge(&mut work, before.work);
            work.link_metadata_items += 1;
            undo.push(boundary::entry(
                &before,
                0,
                &current,
                current_side,
                first,
                last,
                &mut work,
            )?);
            current = before;
            current_side = 1;
        }
        undo.reverse();
        work.link_metadata_items += 2 * (undo.len() / 2);
        // Reach the original live boundary by its actual forward records, not
        // output-equality deduplication or a second whole-note interpretation.
        for group in &self.undo {
            for entry in &group.entries {
                replay.step(entry, true)?;
            }
        }
        current = live.clone();
        work.link_metadata_items += 1;
        current_side = redo_index;
        let mut redo = Vec::with_capacity(self.redo.len());
        work.link_metadata_items += usize::from(!self.redo.is_empty());
        for (index, group) in self.redo.iter().enumerate().rev() {
            let first = group.entries.first().ok_or(EditorError::RecoveryMismatch)?;
            let last = group.entries.last().unwrap();
            for entry in &group.entries {
                replay.step(entry, true)?;
            }
            let source = replay.session.source_text();
            work.materialized_source_bytes += source.len();
            let rewrite = rewrite::Rewrite::prepare(&source, relink)?;
            let mut sides = vec![Side::after(last)];
            work.link_metadata_items += 1;
            if index > 0 {
                let next = self.redo[index - 1]
                    .entries
                    .first()
                    .ok_or(EditorError::RecoveryMismatch)?;
                sides.push(Side::before(next));
                work.link_metadata_items += 1;
            }
            let after = Arc::new(Boundary::prepare(
                &mut replay,
                &source,
                rewrite,
                &sides,
                &mut identities,
            )?);
            charge(&mut work, after.work);
            work.link_metadata_items += 1;
            redo.push(boundary::entry(
                &current,
                current_side,
                &after,
                0,
                first,
                last,
                &mut work,
            )?);
            current = after;
            current_side = 1;
        }
        redo.reverse();
        work.link_metadata_items += 2 * (redo.len() / 2);
        charge(&mut work, replay.work);
        let MappedSide { selection, .. } = live.side(0, &mut work)?;
        let edit = self.prepare_source(self.revision(), live.edit.range, &live.edit.inserted)?;
        work.materialized_source_bytes += edit.inserted.len();
        let mut pending = live.pending.clone();
        work.link_metadata_items += 2 * (1 + pending.ranges.len() + pending.delimiters.len())
            + 5 * (pending.guarded_words.len() + pending.typed_inputs.len());
        pending.work = 0;
        Ok(Some(Prepared {
            edit,
            pending,
            selection,
            undo,
            redo,
            work,
        }))
    }
}
