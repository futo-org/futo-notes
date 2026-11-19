//! Block moves: what a press lifts, where it may land, and the move itself,
//! each handed to the core's `moves` family.
use super::{Accept, EditorSession};
use crate::{
    BlockBoundary, BlockSlots, DisplayOffset, DisplayRange, EditorError, LiftedBlock, Revision,
    ViewChange,
};

impl EditorSession {
    /// What a press at display position `at` (the one under the finger)
    /// lifts for a move: an image there that shares its line with other
    /// content alone, else the block its line lifts. `None` for a blank line,
    /// front matter or code nothing closes.
    pub fn block_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<LiftedBlock>, EditorError> {
        self.engine.block_at(expected, at)
    }

    /// Where that block may land inside display range `within` (both ends
    /// included): each slot a move the engine accepts. A renderer asks for
    /// what is near the screen, and again as it scrolls; the work grows with
    /// the range, not the note. Empty when nothing lifts. Nothing changes.
    pub fn block_slots(
        &self,
        expected: Revision,
        at: DisplayOffset,
        within: DisplayRange,
    ) -> Result<BlockSlots, EditorError> {
        self.engine.block_slots_at(expected, at, within)
    }

    /// Move that block to its slot `to` as one accepted edit and one Undo
    /// step. `None` is a refusal that changed nothing: no block, or `to` is
    /// not one of its slots.
    pub fn move_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
        to: BlockBoundary,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| {
            let change = e.move_block(expected, at, to, accept)?;
            Ok(change.map(|change| e.view(change)))
        })
    }
}
