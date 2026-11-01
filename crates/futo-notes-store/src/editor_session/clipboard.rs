//! Plain Markdown clipboard operations stay canonical editor operations; the
//! store supplies one guarded recovery acceptance for cut and paste. Copying
//! reads the accepted projection, so a paused draft remains copyable.
use super::*;

impl StoreEditorSession<'_> {
    pub fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state
            .engine
            .full()?
            .copy_markdown(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<(String, Option<ViewChange>), EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.input_ready()?;
        let Attachment {
            engine, recovery, ..
        } = &mut *state;
        engine
            .full_mut()?
            .cut_markdown(expected, range, &mut |edit| {
                recovery.append(&self.store.root, edit)
            })
            .map_err(append_error)
    }

    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.input_ready()?;
        let Attachment {
            engine, recovery, ..
        } = &mut *state;
        engine
            .full_mut()?
            .paste_markdown(expected, range, text, &mut |edit| {
                recovery.append(&self.store.root, edit)
            })
            .map_err(append_error)
    }
}

fn append_error(error: EditorError) -> EditorStoreError {
    match error {
        EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
        other => EditorStoreError::Editor(other),
    }
}
