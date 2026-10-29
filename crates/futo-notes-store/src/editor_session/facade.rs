use super::*;

impl StoreEditorSession<'_> {
    /// Ordered own-action changes produced by atomic store workflows. Hosts
    /// apply each once before issuing input against the new revision.
    pub fn take_coordinated_changes(&mut self) -> Result<Vec<ViewChange>, EditorStoreError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        Ok(std::mem::take(&mut state.coordinated))
    }

    #[cfg(test)]
    pub(crate) fn set_append_hook(&mut self, hook: Box<dyn Fn(bool) + Send>) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.set_append_hook(&self.store, hook)
    }

    #[cfg(test)]
    pub(crate) fn set_retirement_failure(&mut self, fail: bool) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.set_retirement_failure(&self.store, fail)
    }

    pub fn recovery_issue(&self) -> Option<RecoveryIssue> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.recovery_issue(&self.store)
    }

    pub fn recovery_status(&self) -> RecoveryStatus {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.recovery_status(&self.store)
    }

    pub fn flush_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.flush_recovery(&self.store)
    }

    pub fn recovery_flush_delay(&self) -> Option<Duration> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.recovery_flush_delay(&self.store)
    }

    pub fn flush_recovery_if_due(&mut self) -> Result<bool, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.flush_recovery_if_due(&self.store)
    }

    pub fn resume_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        let result = state.resume_recovery(&self.store);
        state.lease.bind(&self.state);
        result
    }

    pub fn source_text(&self) -> String {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.source_text(&self.store)
    }

    pub fn display_text(&self) -> String {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.display_text(&self.store)
    }

    pub fn id(&self) -> String {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.id(&self.store)
    }

    pub fn revision(&self) -> Revision {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.revision(&self.store)
    }

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.active_formats(&self.store)
    }

    pub fn selection(&self) -> DisplayRange {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.selection(&self.store)
    }

    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.check_revision(&self.store, expected)
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: futo_notes_editor::DisplayOffset,
        affinity: Affinity,
    ) -> Result<futo_notes_editor::SourceOffset, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.source_at(&self.store, expected, offset, affinity)
    }

    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.display_to_utf16(&self.store, expected, range)
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.project(&self.store, expected, range)
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.select_with_affinity(&self.store, expected, range, affinity)
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.toggle_format(&self.store, expected, format)
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.select_utf16(&self.store, expected, range)
    }

    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.move_caret(&self.store, expected, direction)
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.undo(&self.store, expected)
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.redo(&self.store, expected)
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: futo_notes_editor::ParagraphKey,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.paragraph_key_utf16(&self.store, expected, range, key)
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_utf16(&self.store, expected, range, inserted)
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_utf16_action(&self.store, expected, range, inserted, action)
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayUtf16Replacement],
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_many_utf16(&self.store, expected, replacements)
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace(&self.store, expected, range, inserted)
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_action(&self.store, expected, range, inserted, action)
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayReplacement],
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_many(&self.store, expected, replacements)
    }

    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        let result = state.checkpoint(&self.store);
        state.lease.bind(&self.state);
        result
    }
}
