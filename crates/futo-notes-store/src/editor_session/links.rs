//! Link queries and commands remain canonical editor operations; the store
//! supplies one guarded recovery acceptance before returning the visible delta.
use super::*;
use futo_notes_editor::LinkDescription;

impl StoreEditorSession<'_> {
    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<LinkDescription>, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state
            .engine
            .inspect_link(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.set_link(&self.store, expected, range, destination)
    }
}

impl Attachment {
    pub fn set_link(
        &mut self,
        store: &LocalNoteStore,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .set_link(expected, range, destination, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }
}
