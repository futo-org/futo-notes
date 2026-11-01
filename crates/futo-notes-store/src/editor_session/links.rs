//! Link queries and commands remain canonical editor operations; the store
//! supplies one guarded recovery acceptance before returning the visible delta.
use super::*;
use futo_notes_editor::LinkDescription;

/// The ids `refresh_note_ids` delivers, read from the vault root.
pub(super) fn vault_note_ids(root: &std::path::Path) -> Vec<String> {
    crate::vault::note_order_and_folders(root, crate::NoteSortOrder::default()).0
}

impl StoreEditorSession<'_> {
    /// Deliver the vault's current note ids, read by the store itself, to the
    /// live engine. Nothing is appended; composition, selection and history stay.
    pub fn refresh_note_ids(
        &mut self,
    ) -> Result<futo_notes_editor::NoteIdChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let ids = vault_note_ids(&self.store.root);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        Ok(state.engine.full_mut()?.update_note_ids(&ids))
    }

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
            .full()?
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
            .full_mut()?
            .set_link(expected, range, destination, &mut |edit| {
                self.recovery.append(&store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }
}

impl StoreEditorSession<'_> {
    /// The open `[[` run at the caret and its candidates, from the note ids the
    /// store delivered at open, at reset and on `refresh_note_ids`.
    pub fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<futo_notes_editor::WikilinkCompletion>, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state
            .engine
            .full()?
            .wikilink_completion(expected)
            .map_err(EditorStoreError::Editor)
    }

    /// Accept one candidate as a single recovered edit; stale claims change
    /// nothing and append nothing.
    pub fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.input_ready()?;
        let Attachment {
            engine, recovery, ..
        } = &mut *state;
        let root = &self.store.root;
        engine
            .full_mut()?
            .accept_wikilink_completion(expected, range, query, note_id, &mut |edit| {
                recovery.append(root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }
}
