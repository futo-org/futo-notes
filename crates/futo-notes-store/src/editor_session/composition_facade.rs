use super::*;
use futo_notes_editor::Composition;

impl StoreEditorSession<'_> {
    pub fn composition(&self) -> Option<Composition> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.composition(&self.store)
    }

    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.compose(&self.store, expected, range, text)
    }

    pub fn compose_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
    ) -> Result<Composition, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.compose_utf16(&self.store, expected, range, text)
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.commit_composition_utf16(&self.store, expected, text)
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_os_utf16(&self.store, expected, range, text, placeholders)
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.cancel_composition(&self.store, expected)
    }

    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.commit_composition(&self.store, expected, text)
    }

    pub fn replace_os(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        placeholders: &[DisplayRange],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.replace_os(&self.store, expected, range, text, placeholders)
    }
}
