//! The save decision: write the markdown, converge, recreate or park.
use super::{Attachment, EditorLease, EditorStoreError};
use crate::LocalNoteStore;
use crate::{FlushDisposition, FlushDraftResult};

impl Attachment {
    /// Write the draft to markdown now. Unchanged drafts write nothing. A save
    /// that parks the draft retargets this attachment to the parked note.
    pub fn checkpoint(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<FlushDraftResult, EditorStoreError> {
        let result = self.checkpoint_inner(store);
        if result.is_err() {
            self.schedule_retry();
        }
        result
    }

    fn checkpoint_inner(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<FlushDraftResult, EditorStoreError> {
        // Ordinary autosaves leave IME marked text provisional. Only an
        // actual outside write needs settlement before attempted adoption.
        // This read and the later flush share both mutation guards.
        let outside_write = !self.portable
            && self.relink_offer.is_none()
            && self.engine.composition().is_some()
            && store
                .read_existing(&self.id)
                .map_err(EditorStoreError::Checkpoint)?
                .is_some_and(|disk| disk != self.base);
        if outside_write {
            if let Some(change) = self.commit_composition(self.engine.revision(), None)? {
                self.coordinated.push(change);
            }
        }
        let source = self.engine.source_text();
        // An unanswered relink offer means nothing was edited since the store
        // rewrote links under this still-unrewritten draft: nothing to save.
        // Native clean attachments still reconcile an existing outside source
        // through history-aware adoption. A missing clean note has no draft
        // to persist: never feed it to the edit-wins recreate arm.
        let unchanged = source == self.base
            && (self.portable
                || self.relink_offer.is_some()
                || store
                    .read_existing(&self.id)
                    .map_err(EditorStoreError::Checkpoint)?
                    .is_none_or(|disk| disk == self.base));
        if unchanged || self.relink_offer.is_some() {
            self.mark_saved();
            return Ok(FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            });
        }
        // The portable page owns its history and provisional input. Existing
        // hosts retain parking until their page explicitly opts into adoption.
        let merge = !self.portable;
        let mut adoption = None;
        let result = store
            .flush_draft_decision_locked(&self.id, &self.base, &source, merge, &mut |merged| {
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
        let saved_source = result.source;
        let result = result.flush;
        if let FlushDisposition::ParkedConflict { parked_id } = &result.disposition {
            let lease = EditorLease::acquire(&store.root, parked_id)?;
            self.lease = lease;
            self.id = parked_id.clone();
        }
        self.base = saved_source;
        self.mark_saved();
        Ok(result)
    }
}
