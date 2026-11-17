//! Block movement remains a canonical editor operation; the store applies
//! the move in memory before returning the delta, as it does every edit.
use super::*;
use futo_notes_editor::DisplayOffset;

impl StoreEditorSession<'_> {
    pub fn block_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<DisplayRange>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .block_at(expected, at)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn block_slots(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Vec<DisplayOffset>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .block_slots(expected, at)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn move_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
        to: DisplayOffset,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| {
            state.edit(|session, accept| session.move_block(expected, at, to, accept))
        })
    }
}
