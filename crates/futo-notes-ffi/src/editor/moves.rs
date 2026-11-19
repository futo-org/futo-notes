//! Thin byte-coordinate projection of block movement. Which lines lift,
//! where they land and the move itself stay in the canonical editor.
use super::*;
use futo_notes_editor::{BlockBoundary, LiftedBlock};

/// A boundary between lines: above the line shown from display byte
/// `offset`, or, when `end`, below the note's last line (`offset` is then the
/// display's end). Around a last line that shows no characters (an empty
/// task) the boundary above it and the note's end share `offset`; `end`
/// keeps them apart. A renderer draws a slot at the top of the line starting
/// at `offset`, or below the last line for the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorBlockBoundary {
    pub offset: u64,
    pub end: bool,
}

impl From<BlockBoundary> for EditorBlockBoundary {
    fn from(value: BlockBoundary) -> Self {
        Self {
            offset: value.at.0 as u64,
            end: value.end,
        }
    }
}

impl TryFrom<EditorBlockBoundary> for BlockBoundary {
    type Error = EditorSessionError;
    fn try_from(value: EditorBlockBoundary) -> Result<Self, Self::Error> {
        Ok(Self {
            at: EditorDisplayByteOffset {
                offset: value.offset,
            }
            .try_into()?,
            end: value.end,
        })
    }
}

/// What a press lifts: its display byte extent, and whether its bottom edge
/// is the note's end (below the last line) rather than the start of the line
/// after it. An image lifted out of its line never is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorLiftedBlock {
    pub range: EditorByteRange,
    pub to_end: bool,
}

impl From<LiftedBlock> for EditorLiftedBlock {
    fn from(value: LiftedBlock) -> Self {
        Self {
            range: value.range.into(),
            to_end: value.to_end,
        }
    }
}

#[uniffi::export]
impl NativeEditorSession {
    /// What a press at `at`, the display position under the finger, lifts
    /// for a move: an image there that shares its line with other content
    /// alone, else the block its line lifts (any position on the line off an
    /// image names the line). None for a blank line, front matter or code
    /// nothing closes.
    pub fn block_at(
        &self,
        expected: u64,
        at: EditorDisplayByteOffset,
    ) -> Result<Option<EditorLiftedBlock>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .block_at(Revision(expected), at.try_into()?)?
                .map(Into::into))
        })
    }

    /// Where that block may land among the boundaries inside display bytes
    /// `within` (both ends included), in order; each is a move the engine
    /// accepts. Ask for what is near the screen, and again as it scrolls: the
    /// work grows with the range, not the note. Empty when nothing lifts.
    pub fn block_slots(
        &self,
        expected: u64,
        at: EditorDisplayByteOffset,
        within: EditorByteRange,
    ) -> Result<Vec<EditorBlockBoundary>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .block_slots(Revision(expected), at.try_into()?, within.try_into()?)?
                .slots
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    /// Move that block to its slot `to` as one edit and one Undo step. None
    /// is a refusal that changed nothing: no block, or `to` is not one of its
    /// slots.
    pub fn move_block(
        &self,
        expected: u64,
        at: EditorDisplayByteOffset,
        to: EditorBlockBoundary,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .move_block(Revision(expected), at.try_into()?, to.try_into()?)?
                .map(Into::into))
        })
    }
}
