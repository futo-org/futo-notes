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

/// Replacement semantics for only the changed wikilinks, at an unchanged revision.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorNoteIdChange {
    pub revision: u64,
    pub projections: Vec<EditorProjection>,
}

#[uniffi::export]
impl NativeEditorSession {
    /// The store reads the vault's note ids itself; valid while composing.
    pub fn refresh_note_ids(&self) -> Result<EditorNoteIdChange, EditorSessionError> {
        self.with_session(|session| {
            let change = session.refresh_note_ids()?;
            Ok(EditorNoteIdChange {
                revision: change.revision.0,
                projections: change.projections.into_iter().map(Into::into).collect(),
            })
        })
    }
}
