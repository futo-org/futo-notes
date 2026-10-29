use std::sync::{Arc, Mutex};

use futo_notes_editor::Revision;
use futo_notes_store::{LocalNoteStore, StoreEditorSession};

use crate::FlushDraftResult;

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
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn source_text(&self) -> Result<String, EditorSessionError> {
        self.with_session(|session| Ok(session.source_text()))
    }

    pub fn revision(&self) -> Result<u64, EditorSessionError> {
        self.with_session(|session| Ok(session.revision().0))
    }

    pub fn project(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<EditorProjection, EditorSessionError> {
        self.with_session(|session| {
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
        self.with_session(|session| {
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
        self.with_session(|session| {
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
    pub fn close(&self) -> Result<(), EditorSessionError> {
        self.inner
            .lock()
            .map_err(|_| EditorSessionError::Unavailable)?
            .take();
        Ok(())
    }

    /// Code units preserve malformed foreign input for canonical rejection;
    /// String transport would already have repaired lone surrogates.
    pub fn replace_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        inserted: Vec<u16>,
    ) -> Result<EditorViewChange, EditorSessionError> {
        self.with_session(|session| {
            Ok(session
                .replace_utf16(Revision(expected), range.try_into()?, &inserted)?
                .into())
        })
    }

    pub fn recovery_issue(&self) -> Result<Option<EditorRecoveryIssue>, EditorSessionError> {
        self.with_session(|session| Ok(session.recovery_issue().cloned().map(Into::into)))
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
