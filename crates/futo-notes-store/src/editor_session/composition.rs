//! Marked state is in-memory; only a final action enters the store recovery gate.
use super::*;
use futo_notes_editor::Composition;

impl StoreEditorSession<'_> {
    pub fn composition(&self) -> Option<&Composition> {
        self.engine.composition()
    }

    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .compose(expected, range, text)
            .map_err(EditorStoreError::Editor)
    }

    pub fn compose_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
    ) -> Result<Composition, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .compose_utf16(expected, range, text)
            .map_err(EditorStoreError::Editor)
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .commit_composition_utf16(expected, text, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(input_error)
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .replace_os_utf16(expected, range, text, placeholders, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(input_error)
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorStoreError> {
        self.engine
            .cancel_composition(expected)
            .map_err(EditorStoreError::Editor)
    }

    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .commit_composition(expected, text, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(input_error)
    }

    pub fn replace_os(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        placeholders: &[DisplayRange],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .replace_os(expected, range, text, placeholders, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(input_error)
    }

    fn input_ready(&self) -> Result<(), EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        Ok(())
    }
}

fn input_error(error: EditorError) -> EditorStoreError {
    match error {
        EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
        other => EditorStoreError::Editor(other),
    }
}
