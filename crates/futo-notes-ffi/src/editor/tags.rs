//! Thin tag projection. Tag rules, edits and recovery acceptance remain in the
//! canonical editor/store owners.
use super::*;

#[uniffi::export]
impl NativeEditorSession {
    pub fn tags(&self) -> Result<Vec<String>, EditorSessionError> {
        self.with_session(|session| Ok(session.tags()?))
    }

    pub fn header_tags(&self) -> Result<Vec<String>, EditorSessionError> {
        self.with_session(|session| Ok(session.header_tags()?))
    }

    pub fn add_header_tag(
        &self,
        expected: u64,
        tag: String,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .add_header_tag(Revision(expected), &tag)?
                .map(Into::into))
        })
    }

    pub fn remove_header_tag(
        &self,
        expected: u64,
        tag: String,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .remove_header_tag(Revision(expected), &tag)?
                .map(Into::into))
        })
    }
}
