use std::sync::{Arc, Mutex};

use futo_notes_editor::Revision;
use futo_notes_store::{LocalNoteStore, StoreEditorSession};

use crate::FlushDraftResult;

mod clipboard;
mod composition;
mod contract;
mod correspondence;
pub use correspondence::{EditorCorrespondence, EditorCorrespondenceKind};
mod find;
mod host;
mod host_open;
pub use host::{
    EditorDisplayMirror, EditorFindLanding, EditorFindSnapshot, EditorFindStep, EditorListMarker,
    EditorMirrorEdit, EditorMirrorError, EditorStyleSpan, EditorToolbarHighlights,
};
pub use host_open::{EditorPendingEdits, EditorQuickView};
mod images;
#[cfg(any(target_os = "android", test))]
mod jni_keys;
mod links;
mod tags;
mod toolbar;
pub use contract::*;
pub use find::{editor_find_scan, EditorFindReport, EditorFindScanRequest, EditorFindScanResult};
pub use toolbar::{EditorToolbarList, EditorToolbarSnapshot};
mod tables;
pub use tables::*;

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

    /// Inverse of `display_to_utf16`: native hosts convert UTF-16 selections
    /// to display byte ranges before calling byte-range FFI methods.
    /// Mid-surrogate offsets are rejected.
    pub fn utf16_to_display(
        &self,
        expected: u64,
        range: EditorUtf16Range,
    ) -> Result<EditorByteRange, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .display_from_utf16(Revision(expected), range.try_into()?)?
                .into())
        })
    }

    pub fn undo(&self, expected: u64) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_session(|session| Ok(session.undo(Revision(expected))?.map(Into::into)))
    }

    pub fn redo(&self, expected: u64) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_session(|session| Ok(session.redo(Revision(expected))?.map(Into::into)))
    }

    /// Saves unsaved edits, then releases the attachment. If the save fails the
    /// session stays attached so the caller can retry.
    pub fn detach(&self) -> Result<FlushDraftResult, EditorSessionError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| EditorSessionError::Unavailable)?;
        let session = guard.as_mut().ok_or(EditorSessionError::Unavailable)?;
        let result = session.close()?.into();
        guard.take();
        Ok(result)
    }

    /// Code units preserve malformed foreign input for canonical rejection;
    /// String transport would already have repaired lone surrogates.
    pub fn block_command_utf16(
        &self,
        expected: u64,
        range: EditorUtf16Range,
        command: EditorBlockCommand,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .block_command_utf16(Revision(expected), range.try_into()?, command.into())?
                .map(Into::into))
        })
    }

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

    pub fn save_status(&self) -> Result<EditorSaveStatus, EditorSessionError> {
        self.with_session(|session| Ok(session.save_status().into()))
    }

    /// Remaining time until the next save is due, in the store's clock domain.
    /// None means nothing is unsaved; zero means already due.
    pub fn save_delay(&self) -> Result<Option<std::time::Duration>, EditorSessionError> {
        self.with_session(|session| Ok(session.save_delay()))
    }

    /// Writes the markdown file if the debounce window has closed.
    pub fn save_if_due(&self) -> Result<Option<FlushDraftResult>, EditorSessionError> {
        self.with_session(|session| Ok(session.save_if_due()?.map(Into::into)))
    }

    /// Writes the markdown file now.
    pub fn checkpoint(&self) -> Result<FlushDraftResult, EditorSessionError> {
        self.with_session(|session| Ok(session.checkpoint()?.into()))
    }
}
