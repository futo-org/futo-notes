use super::*;
use futo_notes_editor::{
    BoundedChange, BoundedCursor, BoundedProgress, BoundedProgressChange, BoundedSourceAuthority,
    BoundedWork, DisplayOffset, ProjectionContinuation, SessionToken,
};

pub struct StoreBoundedEditorSession<'store> {
    pub(super) session: StoreEditorSession<'store>,
}

/// Explicit proportional draft copy paired with authority under one lock.
/// Engine revision describes these bytes; recovery watermarks remain separate
/// during a pending coordinated adoption. Copy survives reset and deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreBoundedSourceSnapshot {
    pub source: String,
    pub revision: Revision,
    pub recovery: RecoveryStatus,
    pub reset_required: bool,
    pub deleted: bool,
}

pub struct StoreBoundedEntryError<'store> {
    pub session: StoreEditorSession<'store>,
    pub error: EditorStoreError,
}
pub struct StoreBoundedExitError<'store> {
    pub session: StoreBoundedEditorSession<'store>,
    pub error: EditorStoreError,
}
impl std::fmt::Debug for StoreBoundedEntryError<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}
impl std::fmt::Debug for StoreBoundedExitError<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}

impl<'store> StoreEditorSession<'store> {
    pub fn into_bounded(
        self,
        expected: Revision,
        token: SessionToken,
        body_caret: DisplayOffset,
    ) -> Result<StoreBoundedEditorSession<'store>, StoreBoundedEntryError<'store>> {
        let result = (|| {
            let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
            let _vault = futo_notes_core::files::vault_mutation_guard()
                .map_err(EditorStoreError::Recovery)?;
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.input_ready()?;
            state.engine.full()?;
            // The oldest accepted prefix is protected before proportional
            // certificate/header work. A failed flush publishes no new mode.
            state.flush_recovery(&self.store)?;
            state
                .recovery
                .prepare_bounded(&self.store.root)
                .map_err(EditorStoreError::Recovery)?;
            let Some(EditorMode::Full(engine)) = state.engine.0.take() else {
                unreachable!("checked full owner")
            };
            match engine.into_bounded(expected, token, body_caret) {
                Ok(engine) => {
                    state.engine.0 = Some(EditorMode::Bounded(engine));
                    Ok(())
                }
                Err(error) => {
                    state.engine.0 = Some(EditorMode::Full(*error.session));
                    state
                        .recovery
                        .cancel_bounded_preparation(&self.store.root)
                        .map_err(EditorStoreError::Recovery)?;
                    Err(owner::bounded_error(error.error))
                }
            }
        })();
        match result {
            Ok(()) => Ok(StoreBoundedEditorSession { session: self }),
            Err(error) => Err(StoreBoundedEntryError {
                session: self,
                error,
            }),
        }
    }
}

impl<'store> StoreBoundedEditorSession<'store> {
    pub fn into_full(
        self,
    ) -> Result<(StoreEditorSession<'store>, BoundedWork), StoreBoundedExitError<'store>> {
        let result = (|| {
            let _gate = self
                .session
                .store
                .lock_gate()
                .map_err(EditorStoreError::Recovery)?;
            let _vault = futo_notes_core::files::vault_mutation_guard()
                .map_err(EditorStoreError::Recovery)?;
            let mut state = self
                .session
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            state.input_ready()?;
            let work = state
                .materializing_reset(&self.session.store.root)
                .map_err(EditorStoreError::Recovery)?;
            Ok(work)
        })();
        match result {
            Ok(work) => Ok((self.session, work)),
            Err(error) => Err(StoreBoundedExitError {
                session: self,
                error,
            }),
        }
    }

    pub fn reset_required(&self) -> bool {
        self.session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .engine
            .bounded()
            .is_err()
    }
    pub fn accepted_source(&self) -> StoreBoundedSourceSnapshot {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        StoreBoundedSourceSnapshot {
            source: state.engine.source_text(),
            revision: state.engine.revision(),
            recovery: state.recovery_status(&self.session.store),
            reset_required: state.engine.bounded().is_err(),
            deleted: state.terminal,
        }
    }
    pub fn source_text(&self) -> String {
        self.session.source_text()
    }
    pub fn recovery_status(&self) -> RecoveryStatus {
        self.session.recovery_status()
    }
    pub fn recovery_flush_delay(&self) -> Option<Duration> {
        self.session.recovery_flush_delay()
    }
    pub fn flush_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        self.session.flush_recovery()
    }
    pub fn flush_recovery_if_due(&mut self) -> Result<bool, EditorStoreError> {
        self.session.flush_recovery_if_due()
    }
    pub fn resume_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        self.session.resume_recovery()
    }

    pub fn cursor(&self) -> Result<BoundedCursor, EditorStoreError> {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        Ok(state.engine.bounded()?.cursor())
    }
    pub fn source_authority(&self) -> Result<BoundedSourceAuthority, EditorStoreError> {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        Ok(state.engine.bounded()?.source_authority())
    }
    pub fn preparation_work(&self) -> Result<BoundedWork, EditorStoreError> {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Ok(state.engine.bounded()?.preparation_work())
    }

    fn with_bounded<T>(
        &mut self,
        operation: impl FnOnce(
            &mut futo_notes_editor::BoundedEditorSession,
            &mut RecoveryLog,
            &std::path::Path,
        ) -> Result<T, futo_notes_editor::BoundedError>,
    ) -> Result<T, EditorStoreError> {
        let _gate = self
            .session
            .store
            .lock_gate()
            .map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.input_ready()?;
        let Attachment {
            engine, recovery, ..
        } = &mut *state;
        operation(engine.bounded_mut()?, recovery, &self.session.store.root)
            .map_err(owner::bounded_error)
    }
    pub fn insert_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
    ) -> Result<BoundedChange, EditorStoreError> {
        self.with_bounded(|engine, recovery, root| {
            engine.insert_literal(cursor, at, inserted, &mut |edit| {
                recovery.append(root, edit)
            })
        })
    }
    pub fn insert_prefix_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
    ) -> Result<BoundedProgressChange, EditorStoreError> {
        self.with_bounded(|engine, recovery, root| {
            engine.insert_prefix_literal(cursor, at, inserted, &mut |edit| {
                recovery.append(root, edit)
            })
        })
    }
    pub fn remove_fence_closer(
        &mut self,
        cursor: BoundedCursor,
    ) -> Result<BoundedProgressChange, EditorStoreError> {
        self.with_bounded(|engine, recovery, root| {
            engine.remove_fence_closer(cursor, &mut |edit| recovery.append(root, edit))
        })
    }
    pub fn select_bounded(
        &mut self,
        cursor: BoundedCursor,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<BoundedProgress, EditorStoreError> {
        self.with_bounded(|engine, _, _| engine.select_bounded(cursor, range, affinity))
    }
    pub fn continue_projection(
        &mut self,
        continuation: ProjectionContinuation,
    ) -> Result<BoundedProgress, EditorStoreError> {
        self.with_bounded(|engine, _, _| engine.continue_projection(continuation))
    }
    pub fn undo_bounded(
        &mut self,
        cursor: BoundedCursor,
    ) -> Result<Option<BoundedProgress>, EditorStoreError> {
        self.with_bounded(|engine, recovery, root| {
            engine.undo_bounded(cursor, &mut |edit| recovery.append(root, edit))
        })
    }
    pub fn redo_bounded(
        &mut self,
        cursor: BoundedCursor,
    ) -> Result<Option<BoundedProgress>, EditorStoreError> {
        self.with_bounded(|engine, recovery, root| {
            engine.redo_bounded(cursor, &mut |edit| recovery.append(root, edit))
        })
    }
}
