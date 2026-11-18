//! Thin byte-coordinate projection of block movement. Which lines lift,
//! where they land and the move itself stay in the canonical editor.
use super::*;

#[uniffi::export]
impl NativeEditorSession {
    /// The display extent of what a press at `at`, the display position under
    /// the finger, lifts for a move: an image there that shares its line with
    /// other content alone, else the block its line lifts (any position on
    /// the line off an image names the line). None for a blank line, front
    /// matter or code nothing closes.
    pub fn block_at(
        &self,
        expected: u64,
        at: EditorDisplayByteOffset,
    ) -> Result<Option<EditorByteRange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .block_at(Revision(expected), at.try_into()?)?
                .map(Into::into))
        })
    }

    /// Where that block may land: each slot is the display offset of the line
    /// start below it, or the display's end. Empty when nothing lifts.
    pub fn block_slots(
        &self,
        expected: u64,
        at: EditorDisplayByteOffset,
    ) -> Result<Vec<EditorDisplayByteOffset>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .block_slots(Revision(expected), at.try_into()?)?
                .into_iter()
                .map(|slot| EditorDisplayByteOffset {
                    offset: slot.0 as u64,
                })
                .collect())
        })
    }

    /// Move that block to its slot `to` as one edit and one Undo step. None is
    /// a refusal that changed nothing: no block, not a slot, or a move that
    /// would change what another line reads as.
    pub fn move_block(
        &self,
        expected: u64,
        at: EditorDisplayByteOffset,
        to: EditorDisplayByteOffset,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .move_block(Revision(expected), at.try_into()?, to.try_into()?)?
                .map(Into::into))
        })
    }
}
