//! Block movement remains a canonical editor operation; the store applies
//! the move in memory before returning the delta, as it does every edit.
use super::*;
use futo_notes_editor::{BlockBoundary, BlockSlots, DisplayOffset, LiftedBlock};

impl StoreEditorSession<'_> {
    pub fn block_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<LiftedBlock>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .block_at(expected, at)
                .map_err(EditorStoreError::Editor)
        })
    }

    /// Lists slots by trying each move and putting the note back: nothing
    /// is saved or reported.
    pub fn block_slots(
        &self,
        expected: Revision,
        at: DisplayOffset,
        within: DisplayRange,
    ) -> Result<BlockSlots, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .block_slots(expected, at, within)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn move_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
        to: BlockBoundary,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| {
            state.edit(|session, accept| session.move_block(expected, at, to, accept))
        })
    }
}
