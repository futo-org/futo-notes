//! A code block as one object and its header fields. Hosts ask what a field
//! keeps of typed text and keep no rule of their own.
use super::*;

/// What a code block's language field keeps of `typed`: one word, with no backtick or control
/// character, leading whitespace dropped and other whitespace written `-`.
#[uniffi::export]
pub fn editor_typed_code_block_language(typed: String) -> String {
    futo_notes_editor::typed_code_block_language(&typed)
}

/// What a code block's name field keeps of `typed`: no backtick or control character (a tab or
/// line break becomes a space). Outer spaces stay; trim the name when the field is left.
#[uniffi::export]
pub fn editor_typed_code_block_name(typed: String) -> String {
    futo_notes_editor::typed_code_block_name(&typed)
}

#[uniffi::export]
impl NativeEditorSession {
    /// Select, as one object, the code block whose code shows at display
    /// byte `at` (a tap on its header).
    pub fn select_code_block(
        &self,
        expected: u64,
        at: u64,
    ) -> Result<EditorSelectionChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            let at = usize::try_from(at).map_err(|_| EditorSessionError::InvalidRange)?;
            Ok(session
                .select_code_block(Revision(expected), futo_notes_editor::DisplayOffset(at))?
                .into())
        })
    }

    /// Write a code block's language and `name:` from its header fields, as
    /// one Undo step that keeps the selection. `None` when the block already
    /// has them; `InvalidText` (nothing changed) when they would not read back.
    pub fn set_code_block_header(
        &self,
        expected: u64,
        header: EditorCodeBlockHeader,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .set_code_block_header(Revision(expected), &header.try_into()?)?
                .map(Into::into))
        })
    }
}
