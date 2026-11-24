//! The save decision: write the markdown, converge, recreate or park.
use std::path::Path;

use futo_notes_core::files::collision_key;

use super::{Attachment, EditorLease, EditorStoreError};
use crate::LocalNoteStore;
use crate::{FlushDisposition, FlushDraftResult, MergedDraftResult};
use futo_notes_editor::EditorError;

impl Attachment {
    /// The portable page's adoption of the last offer replayed here: the draft
    /// is the note's source again, so it is the saved baseline.
    pub(super) fn adopt_delivered_offer(&mut self) {
        if self
            .offered
            .as_deref()
            .is_some_and(|offered| self.engine.source_text() == offered)
        {
            let offered = self.offered.take().unwrap_or_default();
            self.set_base(offered);
        }
    }

    /// The file holds `base` (read, written or merged there under the gate)
    /// and the draft equals it. Any offer made against the old baseline is void.
    pub(super) fn set_base(&mut self, base: String) {
        self.base = base;
        self.offered = None;
    }

    /// Write the draft to markdown now. Unchanged drafts write nothing. A save
    /// that parks the draft retargets this attachment to the parked note. A
    /// portable save leaves in `offered` what its page must adopt.
    pub fn checkpoint(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<FlushDraftResult, EditorStoreError> {
        let result = self.checkpoint_inner(store);
        if result.is_err() {
            self.schedule_retry();
        }
        result.map(|result| result.flush)
    }

    fn checkpoint_inner(
        &mut self,
        store: &LocalNoteStore,
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
                .is_some_and(|disk| disk != self.base);
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
        // never parked. A portable clean attachment offers that source to its
        // page through the merge below, which writes nothing. A missing clean
        // note has no draft to persist: never feed it to the edit-wins
        // recreate arm.
        let clean = source == self.base;
        let outside = if clean && self.relink_offer.is_none() {
            store
                .read_existing(&self.id)
                .map_err(EditorStoreError::Checkpoint)?
                .filter(|disk| *disk != self.base)
        } else {
            None
        };
        match outside {
            Some(disk) if !self.portable => return self.follow_outside_source(disk),
            None if clean || self.relink_offer.is_some() => {
                self.offered = None;
                self.mark_saved();
                return Ok(MergedDraftResult {
                    source: self.base.clone(),
                    flush: FlushDraftResult {
                        disposition: FlushDisposition::Converged,
                        mutation: None,
                    },
                });
            }
            _ => {}
        }
        let mut adoption = None;
        let result = store
            .flush_draft_decision_locked(&self.id, &self.base, &source, true, &mut |merged| {
                // The portable page adopts after the write (or re-opens on
                // the file when it cannot), and its Append replays here.
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
            .or_else(|error| {
                // Native screens can leave while a failed save is pending. If
                // the original folder vanished, make the draft durable at the
                // root instead; never recreate an externally moved directory.
                // Check after failure too: the parent can vanish during write.
                if self.portable || !crate::rename_journal::parent_missing(&store.root, &self.id)? {
                    return Err(error);
                }
                let wanted = crate::rename_journal::recovered_root_stem(&self.id);
                // A previous attempt may have installed the copy but failed to
                // acquire its lease. Reuse those exact bytes on retry, just as
                // conflict parking does, rather than minting another suffix.
                let candidates = crate::vault::note_paths(&store.root);
                let existing = candidates.into_iter().find_map(|(id, _)| {
                    let (folder, title) = futo_notes_model::split_id(&id);
                    (folder.is_empty()
                        && crate::paths::is_unique_variant(&wanted, &title)
                        && store.read(&id).as_deref() == Ok(source.as_str()))
                    .then(|| crate::vault::metadata(&store.root, &id))
                    .flatten()
                });
                let metadata = match existing {
                    Some(metadata) => metadata,
                    None => store.install_with_parent_policy(&wanted, &source, None, false)?,
                };
                // A failed merged write did not commit the prepared adoption;
                // the recovered copy holds the local source exactly as typed.
                adoption = None;
                let parked_id = metadata.id.clone();
                let mut mutation = store.upsert_mutation(metadata);
                mutation.removed.push(self.id.clone());
                Ok(MergedDraftResult {
                    source: source.clone(),
                    flush: FlushDraftResult {
                        disposition: FlushDisposition::ParkedConflict { parked_id },
                        mutation: Some(mutation),
                    },
                })
            })
            .map_err(EditorStoreError::Checkpoint)?;
        if let Some(adoption) = adoption {
            let change = self
                .engine
                .apply_external_source(adoption)
                .map_err(EditorStoreError::Editor)?;
            self.coordinated.push(change);
        }
        let saved_id = match &result.flush.disposition {
            FlushDisposition::ParkedConflict { parked_id } => parked_id.clone(),
            _ => self.id.clone(),
        };
        let recreated = result.flush.disposition == FlushDisposition::Recreated;
        let before = recreated.then(|| self.base.clone());
        // A portable draft is the baseline even when the note now holds a
        // merge: the next save merges again against it, so typing past an
        // offer the page has not adopted never overwrites the outside change.
        if self.portable {
            self.saved_as(&store.root, &saved_id, source.clone())?;
            self.offered = (result.source != source).then(|| result.source.clone());
        } else {
            self.saved_as(&store.root, &saved_id, result.source.clone())?;
        }
        if before.is_some() {
            self.recreated_over = before;
        }
        Ok(result)
    }

    /// Note `id` now holds `draft` (written, merged, parked or recreated
    /// there): take that note's lease and make the draft the saved baseline.
    pub(super) fn saved_as(
        &mut self,
        root: &Path,
        id: &str,
        draft: String,
    ) -> Result<(), EditorStoreError> {
        if collision_key(id) != collision_key(&self.id) {
            self.lease = EditorLease::acquire(root, id)?;
            // A recreation is adopted only from the note it recreated.
            self.recreated_over = None;
        }
        self.id = id.to_owned();
        self.set_base(draft);
        self.mark_saved();
        Ok(())
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
        self.set_base(disk.clone());
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
