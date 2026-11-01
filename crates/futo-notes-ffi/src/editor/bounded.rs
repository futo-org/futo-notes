//! Owning native page endpoint. No source-worker can enter this type; native
//! materialization preserves this page's history on the original attachment.
use std::sync::{Arc, Mutex};

use futo_notes_editor::{DisplayOffset, Revision, SessionToken};
use futo_notes_store::StoreBoundedEditorSession;

use super::{
    EditorAffinity, EditorByteRange, EditorRecoveryStatus, EditorSessionError, NativeEditorSession,
};
mod contract;
mod conversion;
pub use contract::*;
use conversion::Conversion;

#[derive(uniffi::Object)]
pub struct NativeBoundedEditorSession {
    inner: Mutex<Option<StoreBoundedEditorSession<'static>>>,
}

fn offset(value: u64) -> Result<DisplayOffset, EditorBoundedError> {
    Ok(DisplayOffset(
        usize::try_from(value).map_err(|_| EditorSessionError::InvalidRange)?,
    ))
}

impl NativeBoundedEditorSession {
    fn with_session<T>(
        &self,
        operation: impl FnOnce(&mut StoreBoundedEditorSession<'static>) -> Result<T, EditorBoundedError>,
    ) -> Result<T, EditorBoundedError> {
        let mut session = self
            .inner
            .lock()
            .map_err(|_| EditorBoundedError::Unavailable)?;
        operation(session.as_mut().ok_or(EditorBoundedError::Unavailable)?)
    }
    fn with_cursor<T>(
        &self,
        cursor: EditorBoundedCursor,
        operation: impl FnOnce(&mut StoreBoundedEditorSession<'static>) -> Result<T, EditorBoundedError>,
    ) -> Result<T, EditorBoundedError> {
        self.with_session(|session| {
            session.reset_operation_work();
            if session.cursor()? != cursor.into() {
                return Err(EditorBoundedError::StaleCursor);
            }
            operation(session)
        })
    }
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn last_bounded_operation_work(
        &self,
    ) -> Result<EditorBoundedWorkReport, EditorBoundedError> {
        let slot = self
            .inner
            .lock()
            .map_err(|_| EditorBoundedError::Unavailable)?;
        let session = slot.as_ref().ok_or(EditorBoundedError::Unavailable)?;
        let mut conversion = Conversion::default();
        let work = conversion.work(session.last_bounded_operation_work());
        Ok(EditorBoundedWorkReport {
            work,
            conversion: conversion.0,
        })
    }
    /// Explicit proportional preparation. The original full owner is restored
    /// on refusal; success makes every old full alias unavailable atomically.
    pub fn into_bounded(
        &self,
        expected: u64,
        token: u64,
        body_caret: u64,
    ) -> Result<Arc<NativeBoundedEditorSession>, EditorBoundedError> {
        let mut slot = self
            .inner
            .lock()
            .map_err(|_| EditorBoundedError::Unavailable)?;
        let session = slot.as_ref().ok_or(EditorBoundedError::Unavailable)?;
        session.reset_bounded_operation_work();
        session
            .check_revision(Revision(expected))
            .map_err(EditorBoundedError::from)?;
        let body_caret = offset(body_caret)?;
        let session = slot.take().ok_or(EditorBoundedError::Unavailable)?;
        match session.into_bounded(Revision(expected), SessionToken(token), body_caret) {
            Ok(session) => Ok(Arc::new(NativeBoundedEditorSession {
                inner: Mutex::new(Some(session)),
            })),
            Err(failure) => {
                *slot = Some(failure.session);
                Err(failure.error.into())
            }
        }
    }
}

#[uniffi::export]
impl NativeBoundedEditorSession {
    /// Latest core attempt under serialized use, available even after a mode
    /// reset or recovery pause. Conversion reports this getter's own output.
    pub fn last_operation_work(&self) -> Result<EditorBoundedWorkReport, EditorBoundedError> {
        self.with_session(|session| {
            let mut conversion = Conversion::default();
            let work = conversion.work(session.last_operation_work());
            Ok(EditorBoundedWorkReport {
                work,
                conversion: conversion.0,
            })
        })
    }
    pub fn cursor(&self) -> Result<EditorBoundedCursor, EditorBoundedError> {
        self.with_session(|session| Ok(session.cursor()?.into()))
    }
    pub fn preparation_work(&self) -> Result<EditorBoundedWorkReport, EditorBoundedError> {
        self.with_session(|session| {
            let mut conversion = Conversion::default();
            let work = conversion.work(session.preparation_work()?);
            Ok(EditorBoundedWorkReport {
                work,
                conversion: conversion.0,
            })
        })
    }
    /// Fixed-width scalar input avoids allocating an arbitrary foreign string
    /// before Rust checks this finite capability. Range width is checked even
    /// on actual 32-bit targets. The engine validates scalar support/UTF-8 cuts.
    pub fn insert_literal(
        &self,
        cursor: EditorBoundedCursor,
        at: u64,
        scalar: u32,
    ) -> Result<EditorBoundedChange, EditorBoundedError> {
        self.with_cursor(cursor, |session| {
            let at = offset(at)?;
            let scalar = char::from_u32(scalar).ok_or(EditorBoundedError::InvalidScalar)?;
            let mut bytes = [0; 4];
            Ok(Conversion::default().change(session.insert_literal(
                cursor.into(),
                at,
                scalar.encode_utf8(&mut bytes),
            )?))
        })
    }
    pub fn insert_prefix_literal(
        &self,
        cursor: EditorBoundedCursor,
        at: u64,
        scalar: u32,
    ) -> Result<EditorBoundedProgressChange, EditorBoundedError> {
        self.with_cursor(cursor, |session| {
            let at = offset(at)?;
            let scalar = char::from_u32(scalar).ok_or(EditorBoundedError::InvalidScalar)?;
            let mut bytes = [0; 4];
            Ok(
                Conversion::default().progress_change(session.insert_prefix_literal(
                    cursor.into(),
                    at,
                    scalar.encode_utf8(&mut bytes),
                )?),
            )
        })
    }
    pub fn remove_fence_closer(
        &self,
        cursor: EditorBoundedCursor,
    ) -> Result<EditorBoundedProgressChange, EditorBoundedError> {
        self.with_cursor(cursor, |session| {
            Ok(Conversion::default().progress_change(session.remove_fence_closer(cursor.into())?))
        })
    }
    pub fn select_bounded(
        &self,
        cursor: EditorBoundedCursor,
        range: EditorByteRange,
        affinity: EditorAffinity,
    ) -> Result<EditorBoundedProgress, EditorBoundedError> {
        self.with_cursor(cursor, |session| {
            Ok(Conversion::default().progress(session.select_bounded(
                cursor.into(),
                range.try_into()?,
                affinity.into(),
            )?))
        })
    }
    pub fn continue_projection(
        &self,
        continuation: EditorProjectionContinuation,
    ) -> Result<EditorBoundedProgress, EditorBoundedError> {
        self.with_session(|session| {
            session.reset_operation_work();
            Ok(Conversion::default().progress(session.continue_projection(continuation.into())?))
        })
    }
    pub fn undo_bounded(
        &self,
        cursor: EditorBoundedCursor,
    ) -> Result<Option<EditorBoundedProgress>, EditorBoundedError> {
        self.with_cursor(cursor, |session| {
            Ok(session
                .undo_bounded(cursor.into())?
                .map(|value| Conversion::default().progress(value)))
        })
    }
    pub fn redo_bounded(
        &self,
        cursor: EditorBoundedCursor,
    ) -> Result<Option<EditorBoundedProgress>, EditorBoundedError> {
        self.with_cursor(cursor, |session| {
            Ok(session
                .redo_bounded(cursor.into())?
                .map(|value| Conversion::default().progress(value)))
        })
    }
    /// Deliberate full-source copy of accepted exact Markdown. Rejected raw
    /// callbacks remain the caller's payload; this is never candidate preview.
    /// Source revision labels these bytes; recovery watermarks are separate.
    pub fn accepted_source(&self) -> Result<EditorBoundedSourceSnapshot, EditorBoundedError> {
        self.with_session(|session| {
            let snapshot = session.accepted_source();
            let copied_text_bytes = snapshot.source.len() as u64;
            Ok(EditorBoundedSourceSnapshot {
                source: snapshot.source,
                revision: snapshot.revision.0,
                recovery: snapshot.recovery.into(),
                reset_required: snapshot.reset_required,
                deleted: snapshot.deleted,
                conversion: EditorBoundedConversionWork {
                    records: 2,
                    copied_text_bytes,
                    ..Default::default()
                },
            })
        })
    }
    pub fn reset_required(&self) -> Result<bool, EditorBoundedError> {
        self.with_session(|session| Ok(session.reset_required()))
    }
    pub fn recovery_status(&self) -> Result<EditorRecoveryStatus, EditorBoundedError> {
        self.with_session(|session| Ok(session.recovery_status().into()))
    }
    pub fn recovery_flush_delay(&self) -> Result<Option<std::time::Duration>, EditorBoundedError> {
        self.with_session(|session| Ok(session.recovery_flush_delay()))
    }
    pub fn flush_recovery(&self) -> Result<EditorRecoveryStatus, EditorBoundedError> {
        self.with_session(|session| {
            session.reset_operation_work();
            Ok(session.flush_recovery()?.into())
        })
    }
    pub fn resume_recovery(&self) -> Result<EditorRecoveryStatus, EditorBoundedError> {
        self.with_session(|session| {
            session.reset_operation_work();
            Ok(session.resume_recovery()?.into())
        })
    }
    /// Deliberate proportional materialization on the same page engine. Failed
    /// prerequisites restore the original bounded owner under this same lock.
    pub fn into_full(&self) -> Result<EditorBoundedFullHandoff, EditorBoundedError> {
        let mut slot = self
            .inner
            .lock()
            .map_err(|_| EditorBoundedError::Unavailable)?;
        slot.as_ref()
            .ok_or(EditorBoundedError::Unavailable)?
            .reset_operation_work();
        let session = slot.take().ok_or(EditorBoundedError::Unavailable)?;
        match session.into_full() {
            Ok((session, work)) => {
                let mut conversion = Conversion::default();
                let work = conversion.work(work);
                Ok(EditorBoundedFullHandoff {
                    session: Arc::new(NativeEditorSession {
                        inner: Mutex::new(Some(session)),
                    }),
                    work,
                    conversion: conversion.0,
                })
            }
            Err(failure) => {
                *slot = Some(failure.session);
                Err(failure.error.into())
            }
        }
    }
    /// Release only this attachment. Accepted recovery remains available to a
    /// later open; no markdown checkpoint or source-worker handoff occurs.
    pub fn detach(&self) -> Result<(), EditorBoundedError> {
        self.inner
            .lock()
            .map_err(|_| EditorBoundedError::Unavailable)?
            .take();
        Ok(())
    }
}
