use super::*;

impl Attachment {
    pub fn recovery_status(&self) -> RecoveryStatus {
        RecoveryStatus {
            accepted: self.recovery.accepted,
            durable: self.recovery.durable,
            flush_deadline: self.recovery.flush_deadline,
            paused: self.terminal
                || self.recovery.failed
                || self.pending_checkpoint.is_some()
                || self.pending_identity.is_some(),
            last_flush_lateness: self.recovery.last_flush_lateness,
        }
    }

    pub fn flush_recovery(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<RecoveryStatus, EditorStoreError> {
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        self.recovery
            .flush(&store.root)
            .map_err(EditorStoreError::RecoveryFlush)?;
        Ok(self.recovery_status())
    }

    /// Run on the host's background worker when `flush_deadline` is reached.
    /// A delayed worker flushes late; it never fabricates an on-time acknowledgement.
    pub fn flush_recovery_if_due(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<bool, EditorStoreError> {
        if !self.recovery.flush_due() {
            return Ok(false);
        }
        self.flush_recovery(store)?;
        Ok(true)
    }

    pub fn resume_recovery(
        &mut self,
        store: &LocalNoteStore,
    ) -> Result<RecoveryStatus, EditorStoreError> {
        self.finish_identity(&store.root)
            .map_err(EditorStoreError::RecoveryResume)?;
        if self.pending_checkpoint.is_some() || self.pending_identity.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if let Some(issue) = &self.recovery.issue {
            if issue.kind != RecoveryIssueKind::TornTail
                && issue.kind != RecoveryIssueKind::BaseMismatch
            {
                return Err(EditorStoreError::RecoveryNeedsReview(issue.clone()));
            }
        }
        if self.recovery.failed {
            super::deletion::recover_live(&store.root, &self.id, &mut self.recovery)
                .map_err(EditorStoreError::RecoveryResume)?;
            self.recovery
                .cancel_prepared_identity(&store.root)
                .map_err(EditorStoreError::RecoveryResume)?;
            self.recovery
                .resume(&store.root)
                .map_err(EditorStoreError::RecoveryResume)?;
        } else {
            // A host may be healthy while its append acknowledgement was lost.
            // Resolve resume + flush under one gate before unpausing its page.
            self.recovery
                .flush(&store.root)
                .map_err(EditorStoreError::RecoveryResume)?;
        }
        Ok(self.recovery_status())
    }

    pub fn toggle_format(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .full_mut()?
            .toggle_format(expected, format, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(EditorStoreError::Editor)
    }

    pub fn undo(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .full_mut()?
            .undo(expected, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }

    pub fn redo(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .full_mut()?
            .redo(expected, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }
}
