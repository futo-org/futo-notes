//! Foreign calls validate fixed-width ranges, then forward to the store owner.
use super::*;

/// Whether `text` is one character paired typing acts on (a backtick, `*`, `~`, `[` or `]`),
/// from the engine's own table: a host splitting a text service's commit asks this.
#[uniffi::export]
pub fn editor_is_paired_typing_key(text: String) -> bool {
    futo_notes_editor::is_paired_typing_key(&text)
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn composition(&self) -> Result<Option<EditorComposition>, EditorSessionError> {
        self.with_session(|session| Ok(session.composition().map(Into::into)))
    }

    pub fn compose_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        text: Vec<u16>,
    ) -> Result<EditorComposition, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .compose_utf16(Revision(expected), range.try_into()?, &text)?
                .into())
        })
    }

    pub fn commit_composition_utf16(
        &self,
        expected: u64,
        text: Option<Vec<u16>>,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .commit_composition_utf16(Revision(expected), text.as_deref())?
                .map(Into::into))
        })
    }

    pub fn cancel_composition(&self, expected: u64) -> Result<(), EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session.cancel_composition(Revision(expected))?)
        })
    }

    pub fn replace_os_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        text: Vec<u16>,
        placeholders: Vec<EditorUtf16Range>,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            let placeholders = placeholders
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<Vec<_>, EditorSessionError>>()?;
            Ok(session
                .replace_os_utf16(Revision(expected), range.try_into()?, &text, &placeholders)?
                .map(Into::into))
        })
    }
}
