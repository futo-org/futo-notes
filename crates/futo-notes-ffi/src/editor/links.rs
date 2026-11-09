//! Thin byte-coordinate link projection. Source interpretation and
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
    pub fn edit_link(
        &self,
        expected: u64,
        range: EditorByteRange,
        label: String,
        destination: String,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .edit_link(Revision(expected), range.try_into()?, &label, &destination)?
                .map(Into::into))
        })
    }
}

/// The address a tapped link destination opens in the system, or none unless it has an explicit
/// allowed scheme (http, https, mailto, tel, sms). A schemeless destination is a note link.
#[uniffi::export]
pub fn editor_external_link_url(destination: String) -> Option<String> {
    futo_notes_editor::external_link_url(&destination)
}

/// The destination to save for what was typed in the link prompt: a schemeless web address gains
/// `https://`; anything else comes back as typed.
#[uniffi::export]
pub fn editor_normalize_link_destination(typed: String) -> String {
    futo_notes_editor::normalize_link_destination(&typed)
}

#[uniffi::export]
impl NativeEditorSession {
    /// The note a tapped schemeless link destination names, or none when it names no note.
    pub fn resolve_note_link(
        &self,
        destination: String,
    ) -> Result<Option<String>, EditorSessionError> {
        self.with_session(|session| Ok(session.resolve_note_link(&destination)?))
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

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorWikilinkCandidate {
    pub note_id: String,
    pub label: String,
    pub detail: Option<String>,
}

/// `range` is exactly what `accept_wikilink_completion` replaces; hand it back
/// with `query` as the claim.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorWikilinkCompletion {
    pub revision: u64,
    pub range: EditorByteRange,
    pub query: String,
    pub candidates: Vec<EditorWikilinkCandidate>,
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn wikilink_completion(
        &self,
        expected: u64,
    ) -> Result<Option<EditorWikilinkCompletion>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .wikilink_completion(Revision(expected))?
                .map(|found| EditorWikilinkCompletion {
                    revision: found.revision.0,
                    range: found.range.into(),
                    query: found.query,
                    candidates: found
                        .candidates
                        .into_iter()
                        .map(|c| EditorWikilinkCandidate {
                            note_id: c.note_id,
                            label: c.label,
                            detail: c.detail,
                        })
                        .collect(),
                }))
        })
    }

    pub fn accept_wikilink_completion(
        &self,
        expected: u64,
        range: EditorByteRange,
        query: String,
        note_id: String,
    ) -> Result<EditorViewChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .accept_wikilink_completion(
                    Revision(expected),
                    range.try_into()?,
                    &query,
                    &note_id,
                )?
                .into())
        })
    }
}
