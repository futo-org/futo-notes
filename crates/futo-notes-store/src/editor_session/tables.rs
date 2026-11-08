//! Table cell queries and commands remain canonical editor operations; the
//! store applies each edit in memory before returning the delta.
use super::*;
use futo_notes_editor::{TableCommand, TableDescription, TableKey, TableOutcome};

impl StoreEditorSession<'_> {
    pub fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .inspect_table(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn inspect_tables(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .inspect_tables(expected, range)
                .map_err(EditorStoreError::Editor)
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
        self.live(|state| state.edit(operation))
    }
}
