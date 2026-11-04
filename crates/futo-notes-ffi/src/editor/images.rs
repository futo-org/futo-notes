//! Thin atom projection and insertion. Roles, spelling, claims and
//! acceptance remain in the canonical editor/store owners.
use super::*;
use futo_notes_editor as editor;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorAtomKind {
    Image,
    Divider,
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorImageDescription {
    pub alt: String,
    pub destination: String,
    pub title: Option<String>,
    pub reference: Option<String>,
    pub vault: bool,
    /// An `http(s)` destination the shell may fetch for display.
    pub remote: bool,
}

/// A non-text atom: draw it as one unit with caret stops only at `before` and
/// `after`.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorAtomDescription {
    pub kind: EditorAtomKind,
    pub range: EditorByteRange,
    pub before: u64,
    pub after: u64,
    pub image: Option<EditorImageDescription>,
}

impl From<editor::AtomDescription> for EditorAtomDescription {
    fn from(value: editor::AtomDescription) -> Self {
        Self {
            kind: match value.kind {
                editor::AtomKind::Image => EditorAtomKind::Image,
                editor::AtomKind::Divider => EditorAtomKind::Divider,
            },
            range: value.range.into(),
            before: value.before.0 as u64,
            after: value.after.0 as u64,
            image: value.image.map(|image| EditorImageDescription {
                remote: futo_notes_core::image::is_http_image_source(&image.destination),
                alt: image.alt,
                destination: image.destination,
                title: image.title,
                reference: image.reference,
                vault: image.vault,
            }),
        }
    }
}

#[uniffi::export]
impl NativeEditorSession {
    /// Begin an asynchronous insertion; present the claim to `insert_image`.
    pub fn image_claim(&self) -> Result<u64, EditorSessionError> {
        self.with_session(|session| Ok(session.image_claim()?.0))
    }

    /// `None` when the caret is in code and nothing was inserted.
    pub fn insert_image(
        &self,
        expected: u64,
        claim: u64,
        reference: String,
        alt: String,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .insert_image(
                    Revision(expected),
                    editor::ImageClaim(claim),
                    &reference,
                    &alt,
                )?
                .map(Into::into))
        })
    }
}
