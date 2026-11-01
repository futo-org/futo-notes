//! Table cell queries and commands remain canonical editor operations; the
//! store supplies one guarded recovery acceptance before returning the delta.
use super::*;
use futo_notes_editor::{TableCommand, TableDescription, TableKey, TableOutcome};

fn append_error(error: EditorError) -> EditorStoreError {
    match error {
        EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
        other => EditorStoreError::Editor(other),
    }
}

impl StoreEditorSession<'_> {
    pub fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, EditorStoreError> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state
            .engine
            .full()?
            .inspect_table(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn replace_in_cell(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.table_edit(|session, accept| {
            session.replace_in_cell(expected, range, inserted, accept)
        })
    }

    pub fn table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.table_edit(|session, accept| session.table_command(expected, range, command, accept))
    }

    pub fn table_key(
        &mut self,
        expected: Revision,
        key: TableKey,
    ) -> Result<Option<TableOutcome>, EditorStoreError> {
        self.table_edit(|session, accept| session.table_key(expected, key, accept))
    }

    fn table_edit<T>(
        &mut self,
        operation: impl FnOnce(
            &mut EditorSession,
            &mut dyn FnMut(&futo_notes_editor::SourceEdit) -> Result<(), String>,
        ) -> Result<T, EditorError>,
    ) -> Result<T, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.table_edit(&self.store, operation)
    }
}

impl Attachment {
    fn table_edit<T>(
        &mut self,
        store: &LocalNoteStore,
        operation: impl FnOnce(
            &mut EditorSession,
            &mut dyn FnMut(&futo_notes_editor::SourceEdit) -> Result<(), String>,
        ) -> Result<T, EditorError>,
    ) -> Result<T, EditorStoreError> {
        self.input_ready()?;
        let recovery = &mut self.recovery;
        operation(self.engine.full_mut()?, &mut |edit| {
            recovery.append(&store.root, edit)
        })
        .map_err(append_error)
    }
}
