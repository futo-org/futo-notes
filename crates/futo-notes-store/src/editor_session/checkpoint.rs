//! The save decision: write the markdown, converge, recreate or park.
use super::{Attachment, EditorLease, EditorStoreError};
use crate::LocalNoteStore;
use crate::{FlushDisposition, FlushDraftResult, MergedDraftResult};
use futo_notes_editor::EditorError;

impl Attachment {
    /// The merged source this portable worker is waiting for its page to adopt.
    /// Once the worker's draft equals it, the merge is the saved baseline.
    pub(super) fn adopt_delivered_merge(&mut self) {
        if self.pending_merge.as_deref().is_some_and(|merged| {
            crate::notes::same_saved_source(&self.engine.source_text(), merged)
        }) {
            self.base = self.pending_merge.take().unwrap_or_default();
        }
    }

    /// Write the draft to markdown now. Unchanged drafts write nothing. A save
    /// that parks the draft retargets this attachment to the parked note.
    pub fn checkpoint(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<FlushDraftResult, EditorStoreError> {
        self.checkpoint_merged(store, false)
            .map(|result| result.flush)
    }

    /// Portable hosts opt into merging: the page, not this engine, adopts the
    /// returned source, but the saved baseline moves here atomically with the
    /// write so a later Undo saves in place instead of parking.
    pub fn checkpoint_merged(
        &mut self,
        store: &LocalNoteStore,
        portable_merge: bool,
    ) -> Result<MergedDraftResult, EditorStoreError> {
        let result = self.checkpoint_inner(store, portable_merge);
        if result.is_err() {
            self.schedule_retry();
        }
        result
    }

    fn checkpoint_inner(
        &mut self,
        store: &LocalNoteStore,
        portable_merge: bool,
    ) -> Result<MergedDraftResult, EditorStoreError> {
        // Ordinary autosaves leave IME marked text provisional. Only an
        // actual outside write needs settlement before attempted adoption.
        // This read and the later flush share both mutation guards.
        let outside_write = !self.portable
            && self.relink_offer.is_none()
            && self.engine.composition().is_some()
            && store
                .read_existing(&self.id)
                .map_err(EditorStoreError::Checkpoint)?
                .is_some_and(|disk| !crate::notes::same_saved_source(&disk, &self.base));
        if outside_write {
            if let Some(change) = self.commit_composition(self.engine.revision(), None)? {
                self.coordinated.push(change);
            }
        }
        let source = self.engine.source_text();
        // An unanswered relink offer means nothing was edited since the store
        // rewrote links under this still-unrewritten draft: nothing to save.
        // A native clean attachment (nothing unsaved) whose existing note
        // changed outside follows that source: it is never a draft, so it is
        // never parked. A missing clean note has no draft to persist: never
        // feed it to the edit-wins recreate arm.
        let clean =
            crate::notes::same_saved_source(&source, &self.base) && self.pending_merge.is_none();
        let outside = if clean && !self.portable && self.relink_offer.is_none() {
            store
                .read_existing(&self.id)
                .map_err(EditorStoreError::Checkpoint)?
                .filter(|disk| !crate::notes::same_saved_source(disk, &self.base))
        } else {
            None
        };
        if let Some(disk) = outside {
            return self.follow_outside_source(disk);
        }
        if clean || self.relink_offer.is_some() {
            self.mark_saved();
            return Ok(MergedDraftResult {
                source: self.base.clone(),
                flush: FlushDraftResult {
                    disposition: FlushDisposition::Converged,
                    mutation: None,
                },
            });
        }
        // The portable page owns its history and provisional input. Existing
        // hosts retain parking until their page explicitly opts into adoption.
        let merge = !self.portable || portable_merge;
        let mut adoption = None;
        let result = store
            .flush_draft_decision_locked(&self.id, &self.base, &source, merge, &mut |merged| {
                // The portable page adopts and its Append replays here.
                if self.portable {
                    return Ok(true);
                }
                match self
                    .engine
                    .prepare_external_source(self.engine.revision(), merged)
                {
                    Ok(prepared) => {
                        adoption = Some(prepared);
                        Ok(true)
                    }
                    Err(_) => Ok(false),
                }
            })
            .map_err(EditorStoreError::Checkpoint)?;
        if let Some(adoption) = adoption {
            let change = self
                .engine
                .apply_external_source(adoption)
                .map_err(EditorStoreError::Editor)?;
            self.coordinated.push(change);
        }
        if let FlushDisposition::ParkedConflict { parked_id } = &result.flush.disposition {
            let lease = EditorLease::acquire(&store.root, parked_id)?;
            self.lease = lease;
            self.id = parked_id.clone();
        }
        // A portable merge is delivered only when the page's adoption Append
        // replays here (`adopt_delivered_merge`). Until then the worker still
        // holds the unmerged draft, so the baseline stays put and any later
        // save parks that draft instead of overwriting the merged disk.
        self.pending_merge = None;
        if portable_merge && result.source != source {
            self.pending_merge = Some(result.source.clone());
        } else {
            self.base = result.source.clone();
        }
        self.mark_saved();
        Ok(result)
    }

    /// Adopt the authoritative source into a clean native session through
    /// history-aware adoption; when its Undo/Redo cannot be rebased (bounds,
    /// ambiguous overlap) drop the history rather than park a stale copy.
    fn follow_outside_source(
        &mut self,
        disk: String,
    ) -> Result<MergedDraftResult, EditorStoreError> {
        let revision = self.engine.revision();
        let adoption = match self.engine.prepare_external_source(revision, &disk) {
            Err(EditorError::UnrepresentableFormat | EditorError::InvalidRange) => self
                .engine
                .prepare_external_source_dropping_history(revision, &disk),
            other => other,
        }
        .map_err(EditorStoreError::Editor)?;
        let change = self
            .engine
            .apply_external_source(adoption)
            .map_err(EditorStoreError::Editor)?;
        self.coordinated.push(change);
        self.base = disk.clone();
        self.mark_saved();
        Ok(MergedDraftResult {
            source: disk,
            flush: FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            },
        })
    }
}
