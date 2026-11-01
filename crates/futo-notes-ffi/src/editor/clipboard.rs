//! Thin byte-coordinate plain Markdown clipboard projection. Clipboard policy
//! and recovery acceptance remain in the canonical editor/store owners.
use super::*;

/// Copied Markdown plus the removal change, absent for an empty selection.
#[derive(Debug, uniffi::Record)]
pub struct EditorCutResult {
    pub markdown: String,
    pub change: Option<EditorViewChange>,
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn copy_markdown(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<String, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session.copy_markdown(Revision(expected), range.try_into()?)?)
        })
    }

    pub fn cut_markdown(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<EditorCutResult, EditorSessionError> {
        self.with_revision(expected, |session| {
            let (markdown, change) = session.cut_markdown(Revision(expected), range.try_into()?)?;
            Ok(EditorCutResult {
                markdown,
                change: change.map(Into::into),
            })
        })
    }

    pub fn paste_markdown(
        &self,
        expected: u64,
        range: EditorByteRange,
        text: String,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .paste_markdown(Revision(expected), range.try_into()?, &text)?
                .map(Into::into))
        })
    }
}
