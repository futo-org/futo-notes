use std::sync::{Arc, Mutex};

use futo_notes_editor::Revision;
use futo_notes_store::{LocalNoteStore, StoreEditorSession};

use crate::FlushDraftResult;

mod composition;
mod contract;
pub use contract::*;

/// Blocking store endpoint. Call on the native I/O worker, including append
/// acceptance before displaying a returned change. No callbacks cross this lock.
#[derive(uniffi::Object)]
pub struct NativeEditorSession {
    inner: Mutex<Option<StoreEditorSession<'static>>>,
}

impl NativeEditorSession {
    pub(crate) fn open(
        store: &Arc<LocalNoteStore>,
        id: &str,
    ) -> Result<Arc<Self>, EditorSessionError> {
        Ok(Arc::new(Self {
            inner: Mutex::new(Some(store.open_owned_editor(id)?)),
        }))
    }

    fn with_session<T>(
        &self,
        operation: impl FnOnce(&mut StoreEditorSession<'static>) -> Result<T, EditorSessionError>,
    ) -> Result<T, EditorSessionError> {
        let mut session = self
            .inner
            .lock()
            .map_err(|_| EditorSessionError::Unavailable)?;
        operation(session.as_mut().ok_or(EditorSessionError::Unavailable)?)
    }

    fn with_revision<T>(
        &self,
        expected: u64,
        operation: impl FnOnce(&mut StoreEditorSession<'static>) -> Result<T, EditorSessionError>,
    ) -> Result<T, EditorSessionError> {
        self.with_session(|session| {
            session.check_revision(Revision(expected))?;
            operation(session)
        })
    }
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn note_id(&self) -> Result<String, EditorSessionError> {
        self.with_session(|session| Ok(session.id()))
    }

    pub fn take_coordinated_changes(&self) -> Result<Vec<EditorViewChange>, EditorSessionError> {
        self.with_session(|session| {
            Ok(session
                .take_coordinated_changes()?
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    pub fn source_text(&self) -> Result<String, EditorSessionError> {
        self.with_session(|session| Ok(session.source_text()))
    }

    pub fn revision(&self) -> Result<u64, EditorSessionError> {
        self.with_session(|session| Ok(session.revision().0))
    }

    pub fn source_at(
        &self,
        expected: u64,
        offset: EditorDisplayByteOffset,
        affinity: EditorAffinity,
    ) -> Result<EditorSourceByteOffset, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(EditorSourceByteOffset {
                offset: session
                    .source_at(
                        Revision(expected),
                        futo_notes_editor::DisplayOffset(
                            usize::try_from(offset.offset)
                                .map_err(|_| EditorSessionError::InvalidRange)?,
                        ),
                        affinity.into(),
                    )?
                    .0 as u64,
            })
        })
    }

    pub fn project(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<EditorProjection, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .project(Revision(expected), range.try_into()?)?
                .into())
        })
    }

    pub fn display_text(&self) -> Result<String, EditorSessionError> {
        self.with_session(|session| Ok(session.display_text()))
    }

    pub fn select_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
    ) -> Result<EditorSelectionChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .select_utf16(Revision(expected), range.try_into()?)?
                .into())
        })
    }

    pub fn display_to_utf16(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<EditorUtf16Range, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .display_to_utf16(Revision(expected), range.try_into()?)?
                .into())
        })
    }

    pub fn undo(&self, expected: u64) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_session(|session| Ok(session.undo(Revision(expected))?.map(Into::into)))
    }

    pub fn redo(&self, expected: u64) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_session(|session| Ok(session.redo(Revision(expected))?.map(Into::into)))
    }

    /// Releases the attachment without silently saving or discarding recovery.
    pub fn detach(&self) -> Result<(), EditorSessionError> {
        self.inner
            .lock()
            .map_err(|_| EditorSessionError::Unavailable)?
            .take();
        Ok(())
    }

    /// Code units preserve malformed foreign input for canonical rejection;
    /// String transport would already have repaired lone surrogates.
    pub fn paragraph_key_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        key: EditorParagraphKey,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .paragraph_key_utf16(Revision(expected), range.try_into()?, key.into())?
                .map(Into::into))
        })
    }

    pub fn replace_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        inserted: Vec<u16>,
    ) -> Result<EditorViewChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .replace_utf16(Revision(expected), range.try_into()?, &inserted)?
                .into())
        })
    }

    pub fn replace_utf16_action(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        inserted: Vec<u16>,
        action: EditorInputAction,
    ) -> Result<EditorViewChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .replace_utf16_action(
                    Revision(expected),
                    range.try_into()?,
                    &inserted,
                    action.into(),
                )?
                .into())
        })
    }

    pub fn replace_many_utf16(
        &self,
        expected: u64,
        replacements: Vec<EditorUtf16Replacement>,
    ) -> Result<EditorViewChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            let replacements = replacements
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<Vec<_>, EditorSessionError>>()?;
            Ok(session
                .replace_many_utf16(Revision(expected), &replacements)?
                .into())
        })
    }

    pub fn select_with_affinity(
        &self,
        expected: u64,
        range: EditorByteRange,
        affinity: EditorAffinity,
    ) -> Result<EditorSelectionChange, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .select_with_affinity(Revision(expected), range.try_into()?, affinity.into())?
                .into())
        })
    }

    pub fn toggle_format(
        &self,
        expected: u64,
        format: EditorInlineFormat,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .toggle_format(Revision(expected), format.into())?
                .map(Into::into))
        })
    }

    pub fn active_formats(&self) -> Result<Vec<EditorInlineFormat>, EditorSessionError> {
        self.with_session(|session| {
            Ok(session
                .active_formats()
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    pub fn recovery_issue(&self) -> Result<Option<EditorRecoveryIssue>, EditorSessionError> {
        self.with_session(|session| Ok(session.recovery_issue().map(Into::into)))
    }

    pub fn resume_recovery(&self) -> Result<EditorRecoveryStatus, EditorSessionError> {
        self.with_session(|session| Ok(session.resume_recovery()?.into()))
    }

    pub fn recovery_status(&self) -> Result<EditorRecoveryStatus, EditorSessionError> {
        self.with_session(|session| Ok(session.recovery_status().into()))
    }

    pub fn flush_recovery(&self) -> Result<EditorRecoveryStatus, EditorSessionError> {
        self.with_session(|session| Ok(session.flush_recovery()?.into()))
    }

    pub fn checkpoint(&self) -> Result<FlushDraftResult, EditorSessionError> {
        self.with_session(|session| Ok(session.checkpoint()?.into()))
    }
}
