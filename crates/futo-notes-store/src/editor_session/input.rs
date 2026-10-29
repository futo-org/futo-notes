//! Protected editor input: one store gate and recovery append per user action.
use super::*;

#[allow(unused_variables)]
impl Attachment {
    pub fn paragraph_key_utf16(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayUtf16Range,
        key: futo_notes_editor::ParagraphKey,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        if self.pending_checkpoint.is_some() || self.pending_identity.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        self.engine
            .paragraph_key_utf16(expected, range, key, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }

    pub fn replace_utf16(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        let (range, inserted) = self
            .engine
            .decode_utf16_input(expected, range, inserted)
            .map_err(EditorStoreError::Editor)?;
        self.replace(store, expected, range, &inserted)
    }

    pub fn replace_utf16_action(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        let (range, inserted) = self
            .engine
            .decode_utf16_input(expected, range, inserted)
            .map_err(EditorStoreError::Editor)?;
        self.replace_action(store, expected, range, &inserted, action)
    }

    pub fn replace_many_utf16(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayUtf16Replacement],
    ) -> Result<ViewChange, EditorStoreError> {
        let replacements = self
            .engine
            .decode_utf16_replacements(expected, replacements)
            .map_err(EditorStoreError::Editor)?;
        self.replace_many(store, expected, &replacements)
    }

    pub fn replace(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        self.replace_action(
            store,
            expected,
            range,
            inserted,
            futo_notes_editor::InputAction::Typing,
        )
    }

    pub fn replace_action(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        if self.pending_checkpoint.is_some() || self.pending_identity.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        self.engine
            .replace_action(expected, range, inserted, action, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }

    pub fn replace_many(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayReplacement],
    ) -> Result<ViewChange, EditorStoreError> {
        if self.pending_checkpoint.is_some() || self.pending_identity.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        self.engine
            .replace_many(expected, replacements, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }
}
