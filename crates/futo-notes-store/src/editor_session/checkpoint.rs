use super::{EditorLease, EditorStoreError, RecoveryIssueKind, StoreEditorSession};
use crate::{FlushDisposition, FlushDraftResult};

impl StoreEditorSession<'_> {
    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        if let Some(issue) = &self.recovery.issue {
            if issue.kind != RecoveryIssueKind::BaseMismatch {
                return Err(EditorStoreError::RecoveryNeedsReview(issue.clone()));
            }
        }
        if self.recovery.failed && self.pending_checkpoint.is_none() {
            return Err(EditorStoreError::RecoveryPaused);
        }
        let _gate = self
            .store
            .lock_gate()
            .map_err(EditorStoreError::Checkpoint)?;
        let _vault_mutation =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Checkpoint)?;
        let source = self.engine.source_text();
        // A committed checkpoint whose retirement failed may be replaced by a
        // controlled writer before retry. Revalidate its destination under the
        // same guard; a cached result alone cannot authorize log retirement.
        if let Some(pending) = &self.pending_checkpoint {
            let target = match &pending.disposition {
                FlushDisposition::ParkedConflict { parked_id } => parked_id,
                _ => &self.id,
            };
            if self
                .store
                .read_existing(target)
                .map_err(EditorStoreError::Checkpoint)?
                .as_deref()
                != Some(source.as_str())
            {
                self.pending_checkpoint = None;
            } else if pending.mutation.is_some() {
                // Retrying the same commit must still return today's complete
                // projection: unrelated writes may have changed its list rank.
                let metadata =
                    crate::vault::metadata(&self.store.root, target).ok_or_else(|| {
                        EditorStoreError::Checkpoint(
                            "checkpoint target metadata unavailable".into(),
                        )
                    })?;
                let mut refreshed = pending.clone();
                refreshed.mutation = Some(self.store.upsert_mutation(metadata));
                self.pending_checkpoint = Some(refreshed);
            }
        }
        // Opening/closing an unchanged note must not write its old bytes over
        // a peer change or mint a conflict copy for a draft that never existed.
        let result = if let Some(result) = &self.pending_checkpoint {
            result.clone()
        } else if source == self.recovery.base() {
            FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            }
        } else {
            let base = self.recovery.base().to_owned();
            if self
                .recovery
                .replaced(&self.store.root)
                .map_err(EditorStoreError::Checkpoint)?
                && self
                    .store
                    .read_existing(&self.id)
                    .map_err(EditorStoreError::Checkpoint)?
                    .as_deref()
                    != Some(source.as_str())
            {
                self.store
                    .park_conflict_draft_with_target(&self.id, &source, &mut |id| {
                        self.recovery.protect_checkpoint(&self.store.root, id)
                    })
                    .map_err(EditorStoreError::Checkpoint)?
            } else {
                self.store
                    .flush_draft_locked_with_target(&self.id, &base, &source, &mut |id| {
                        self.recovery.protect_checkpoint(&self.store.root, id)
                    })
                    .map_err(EditorStoreError::Checkpoint)?
            }
        };
        let final_id = match &result.disposition {
            FlushDisposition::ParkedConflict { parked_id } => parked_id.clone(),
            _ => self.id.clone(),
        };
        self.pending_checkpoint = Some(result.clone());
        if source != self.recovery.base() {
            let relative = crate::note_filename(&final_id);
            futo_notes_core::files::vault_fs::sync_file(&self.store.root, &relative)
                .and_then(|()| {
                    futo_notes_core::files::vault_fs::sync_parent(&self.store.root, &relative)
                })
                .map_err(|error| EditorStoreError::CheckpointCommitted {
                    result: Box::new(result.clone()),
                    error,
                })?;
        }
        let next_lease = if final_id != self.id {
            // The committed destination may carry another session's pending
            // stream even if its checkpoint file was absent. Keep our original
            // stream until that draft is recovered; retargeting now would make
            // a later append/resume operate on foreign recovery bytes.
            if futo_notes_core::files::recovery_coordination::has_pending_recovery(
                &self.store.root,
                &final_id,
            )
            .map_err(|error| EditorStoreError::CheckpointCommitted {
                result: Box::new(result.clone()),
                error,
            })? {
                return Err(EditorStoreError::CheckpointCommitted {
                    result: Box::new(result),
                    error: "checkpoint destination has pending editor recovery".into(),
                });
            }
            Some(
                EditorLease::acquire(&self.store.root, &final_id).map_err(|error| {
                    EditorStoreError::CheckpointCommitted {
                        result: Box::new(result.clone()),
                        error: error.to_string(),
                    }
                })?,
            )
        } else {
            None
        };
        if let Err(error) =
            self.recovery
                .retire(&self.store.root, &final_id, &source, self.engine.revision())
        {
            return Err(EditorStoreError::CheckpointCommitted {
                result: Box::new(result),
                error,
            });
        }
        if let Some(lease) = next_lease {
            self.lease = lease;
            self.id = final_id;
        }
        self.pending_checkpoint = None;
        Ok(result)
    }
}
