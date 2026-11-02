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
        let source = self.engine.source_text();
        // An unanswered relink offer means nothing was edited since the store
        // rewrote links under this still-unrewritten draft: nothing to save.
        if source == self.base || self.relink_offer.is_some() {
            self.mark_saved();
            return Ok(FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            });
        }
        let result = store
            .flush_draft_locked(&self.id, &self.base, &source)
            .map_err(EditorStoreError::Checkpoint)?;
        if let FlushDisposition::ParkedConflict { parked_id } = &result.disposition {
            let lease = EditorLease::acquire(&store.root, parked_id)?;
            self.lease = lease;
            self.id = parked_id.clone();
        }
        self.base = source;
        self.mark_saved();
        Ok(result)
    }
}
