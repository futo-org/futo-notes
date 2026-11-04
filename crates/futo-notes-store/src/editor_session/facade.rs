use super::*;

impl StoreEditorSession<'_> {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, Attachment> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lock only: usable on a deleted or paused attachment.
    pub(super) fn read<R>(&self, f: impl FnOnce(&mut Attachment) -> R) -> R {
        f(&mut self.lock_state())
    }

    /// Lock, then `SessionDeleted` once terminal. Input, selection, composition and
    /// history use only this: no store gate or vault guard, so typing never waits on
    /// another workflow. Never take the gate while holding the attachment lock
    /// (identity transitions lock the attachment while holding the gate).
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
    /// Only workflows that touch the vault (saving) use this.
    pub(super) fn mutate<R>(
        &self,
        f: impl FnOnce(&mut Attachment, &LocalNoteStore) -> Result<R, EditorStoreError>,
    ) -> Result<R, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
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

    /// Where the session stands relative to the markdown file.
    pub fn save_status(&self) -> SaveStatus {
        self.read(|state| state.save_status())
    }

    /// Time left until the next save is due (zero when overdue); `None` when
    /// every edit is saved. Arrange a `save_if_due` call on this worker then.
    pub fn save_delay(&self) -> Option<Duration> {
        self.read(|state| state.save_delay())
    }

    /// Save now if the debounce window has closed.
    pub fn save_if_due(&mut self) -> Result<Option<FlushDraftResult>, EditorStoreError> {
        self.mutate(|state, store| {
            if !state.save_due() {
                return Ok(None);
            }
            let result = state.checkpoint(store);
            state.lease.bind(&self.state);
            result.map(Some)
        })
    }

    /// Save, then release the attachment. A failed save returns its error and
    /// leaves the session attached so the caller can retry or copy the draft.
    pub fn close(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
        let mut state = self.lock_state();
        if state.terminal {
            return Ok(FlushDraftResult {
                disposition: crate::FlushDisposition::Converged,
                mutation: None,
            });
        }
        let result = state.checkpoint(&self.store)?;
        state.terminal = true;
        state.lease.release();
        Ok(result)
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
        self.read(|state| state.engine.active_formats())
    }

    pub fn toolbar_state(&self) -> futo_notes_editor::ToolbarState {
        self.read(|state| state.engine.toolbar_state())
    }

    pub fn selection(&self) -> DisplayRange {
        self.read(|state| state.engine.selection())
    }

    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorStoreError> {
        self.read(|state| {
            state
                .engine
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
        self.live(|state| {
            state
                .engine
                .select_with_affinity(expected, range, affinity)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.toggle_format(expected, format))
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .select_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .move_caret(expected, direction)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.undo(expected))
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.redo(expected))
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: futo_notes_editor::BlockCommand,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.block_command_utf16(expected, range, command))
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: futo_notes_editor::ParagraphKey,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.paragraph_key_utf16(expected, range, key))
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_utf16(expected, range, inserted))
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_utf16_action(expected, range, inserted, action))
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayUtf16Replacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_many_utf16(expected, replacements))
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace(expected, range, inserted))
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_action(expected, range, inserted, action))
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayReplacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_many(expected, replacements))
    }

    /// Write the markdown now.
    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        self.mutate(|state, store| {
            let result = state.checkpoint(store);
            state.lease.bind(&self.state);
            result
        })
    }

    pub(super) fn checkpoint_merged(
        &mut self,
    ) -> Result<crate::MergedDraftResult, EditorStoreError> {
        self.mutate(|state, store| {
            let result = state.checkpoint_merged(store, true);
            state.lease.bind(&self.state);
            result
        })
    }
}
