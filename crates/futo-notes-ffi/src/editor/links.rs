//! Thin byte-coordinate link projection. Source interpretation and recovery
//! acceptance remain in the canonical editor/store owners.
use super::*;

#[uniffi::export]
impl NativeEditorSession {
    pub fn inspect_link(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<Option<EditorLinkDescription>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .inspect_link(Revision(expected), range.try_into()?)?
                .map(Into::into))
        })
    }

    pub fn set_link(
        &self,
        expected: u64,
        range: EditorByteRange,
        destination: String,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .set_link(Revision(expected), range.try_into()?, &destination)?
                .map(Into::into))
        })
    }
}
