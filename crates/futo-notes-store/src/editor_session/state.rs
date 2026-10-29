use super::*;

#[allow(unused_variables)]
impl Attachment {
    #[cfg(test)]
    pub(crate) fn set_append_hook(
        &mut self,
        store: &LocalNoteStore,
        hook: Box<dyn Fn(bool) + Send>,
    ) {
        self.recovery.append_hook = Some(hook);
    }
    #[cfg(test)]
    pub(crate) fn set_retirement_failure(&mut self, store: &LocalNoteStore, fail: bool) {
        self.recovery.fail_retirement = fail;
    }
    pub fn recovery_issue(&self, store: &LocalNoteStore) -> Option<RecoveryIssue> {
        self.recovery.issue.clone()
    }

    pub fn recovery_status(&self, store: &LocalNoteStore) -> RecoveryStatus {
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
        Ok(self.recovery_status(store))
    }

    /// Time remaining until the oldest unflushed edit's target, usable even
    /// with the default clock whose origin is private to this session.
    pub fn recovery_flush_delay(&self, store: &LocalNoteStore) -> Option<Duration> {
        self.recovery.flush_delay()
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
        Ok(self.recovery_status(store))
    }

    pub fn source_text(&self, store: &LocalNoteStore) -> String {
        self.engine.source_text()
    }
    pub fn display_text(&self, store: &LocalNoteStore) -> String {
        self.engine.display_text()
    }
    pub fn id(&self, store: &LocalNoteStore) -> String {
        self.id.clone()
    }
    pub fn revision(&self, store: &LocalNoteStore) -> Revision {
        self.engine.revision()
    }

    pub fn active_formats(&self, store: &LocalNoteStore) -> Vec<InlineFormat> {
        self.engine.active_formats()
    }

    pub fn selection(&self, store: &LocalNoteStore) -> DisplayRange {
        self.engine.selection()
    }

    pub fn check_revision(
        &self,
        store: &LocalNoteStore,
        expected: Revision,
    ) -> Result<(), EditorStoreError> {
        self.engine
            .check_revision(expected)
            .map_err(EditorStoreError::Editor)
    }

    pub fn source_at(
        &self,
        store: &LocalNoteStore,
        expected: Revision,
        offset: futo_notes_editor::DisplayOffset,
        affinity: Affinity,
    ) -> Result<futo_notes_editor::SourceOffset, EditorStoreError> {
        self.engine
            .source_at(expected, offset, affinity)
            .map_err(EditorStoreError::Editor)
    }

    pub fn display_to_utf16(
        &self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorStoreError> {
        self.engine
            .display_to_utf16(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn project(
        &self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorStoreError> {
        self.engine
            .project(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn select_with_affinity(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.engine
            .select_with_affinity(expected, range, affinity)
            .map_err(EditorStoreError::Editor)
    }

    pub fn toggle_format(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .toggle_format(expected, format, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(EditorStoreError::Editor)
    }

    pub fn select_utf16(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.engine
            .select_utf16(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn move_caret(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.engine
            .move_caret(expected, direction)
            .map_err(EditorStoreError::Editor)
    }

    pub fn undo(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        self.engine
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
            .redo(expected, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }
}
