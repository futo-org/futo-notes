use super::*;

impl StoreEditorSession<'_> {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, Attachment> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lock only: usable on a deleted or paused attachment.
    pub(super) fn read<R>(&self, f: impl FnOnce(&mut Attachment) -> R) -> R {
        f(&mut self.lock_state())
    }

    /// Lock, then `SessionDeleted` once terminal. No gate: never writes recovery.
    pub(super) fn live<R>(
        &self,
        f: impl FnOnce(&mut Attachment) -> Result<R, EditorStoreError>,
    ) -> Result<R, EditorStoreError> {
        let mut state = self.lock_state();
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        f(&mut state)
    }

    /// Gate, then vault guard, then state lock (this order), then the terminal check.
    pub(super) fn mutate<R>(
        &self,
        f: impl FnOnce(&mut Attachment, &LocalNoteStore) -> Result<R, EditorStoreError>,
    ) -> Result<R, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.lock_state();
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        f(&mut state, &self.store)
    }

    /// Ordered own-action changes produced by atomic store workflows. Hosts
    /// apply each once before issuing input against the new revision.
    pub fn take_coordinated_changes(&mut self) -> Result<Vec<ViewChange>, EditorStoreError> {
        self.live(|state| Ok(std::mem::take(&mut state.coordinated)))
    }

    #[cfg(test)]
    pub(crate) fn set_append_hook(&mut self, hook: Box<dyn Fn(bool) + Send>) {
        self.read(|state| state.recovery.append_hook = Some(hook))
    }

    #[cfg(test)]
    pub(crate) fn set_retirement_failure(&mut self, fail: bool) {
        self.read(|state| state.recovery.fail_retirement = fail)
    }

    pub fn recovery_issue(&self) -> Option<RecoveryIssue> {
        self.read(|state| state.recovery.issue.clone())
    }

    pub fn recovery_status(&self) -> RecoveryStatus {
        self.read(|state| state.recovery_status())
    }

    pub fn flush_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        self.mutate(|state, store| state.flush_recovery(store))
    }

    pub fn recovery_flush_delay(&self) -> Option<Duration> {
        self.read(|state| state.recovery.flush_delay())
    }

    pub fn flush_recovery_if_due(&mut self) -> Result<bool, EditorStoreError> {
        self.mutate(|state, store| state.flush_recovery_if_due(store))
    }

    pub fn resume_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        self.mutate(|state, store| {
            let result = state.resume_recovery(store);
            state.lease.bind(&self.state);
            result
        })
    }

    pub fn source_text(&self) -> String {
        self.read(|state| state.engine.source_text())
    }

    pub fn display_text(&self) -> String {
        self.read(|state| state.engine.display_text())
    }

    pub fn id(&self) -> String {
        self.read(|state| state.id.clone())
    }

    pub fn revision(&self) -> Revision {
        self.read(|state| state.engine.revision())
    }

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        self.read(|state| {
            state
                .engine
                .full()
                .expect("full interface owner")
                .active_formats()
        })
    }

    pub fn selection(&self) -> DisplayRange {
        self.read(|state| {
            state
                .engine
                .full()
                .expect("full interface owner")
                .selection()
        })
    }

    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .full()?
                .check_revision(expected)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: futo_notes_editor::DisplayOffset,
        affinity: Affinity,
    ) -> Result<futo_notes_editor::SourceOffset, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .full()?
                .source_at(expected, offset, affinity)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .full()?
                .display_to_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn display_from_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<DisplayRange, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .full()?
                .display_from_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .full()?
                .project(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.mutate(|state, _| {
            state
                .engine
                .full_mut()?
                .select_with_affinity(expected, range, affinity)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.mutate(|state, store| state.toggle_format(store, expected, format))
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.mutate(|state, _| {
            state
                .engine
                .full_mut()?
                .select_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.mutate(|state, _| {
            state
                .engine
                .full_mut()?
                .move_caret(expected, direction)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.mutate(|state, store| state.undo(store, expected))
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.mutate(|state, store| state.redo(store, expected))
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: futo_notes_editor::BlockCommand,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.mutate(|state, store| state.block_command_utf16(store, expected, range, command))
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: futo_notes_editor::ParagraphKey,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.mutate(|state, store| state.paragraph_key_utf16(store, expected, range, key))
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        self.mutate(|state, store| state.replace_utf16(store, expected, range, inserted))
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.mutate(|state, store| {
            state.replace_utf16_action(store, expected, range, inserted, action)
        })
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayUtf16Replacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.mutate(|state, store| state.replace_many_utf16(store, expected, replacements))
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        self.mutate(|state, store| state.replace(store, expected, range, inserted))
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.mutate(|state, store| state.replace_action(store, expected, range, inserted, action))
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayReplacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.mutate(|state, store| state.replace_many(store, expected, replacements))
    }

    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        self.mutate(|state, store| {
            let result = state.checkpoint(store);
            state.lease.bind(&self.state);
            result
        })
    }
}
