use futo_notes_editor::{
    CaretDirection, DisplayRange, DisplayUtf16Range, EditorError, EditorSession, Revision,
    SelectionChange, ViewChange,
};

use crate::{paths, FlushDisposition, FlushDraftResult, LocalNoteStore, NOTE_NOT_FOUND};

mod lease;
mod recovery;
use lease::EditorLease;
use recovery::RecoveryLog;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorStoreError {
    Open(String),
    SessionAlreadyOpen,
    Editor(EditorError),
    Recovery(String),
    Checkpoint(String),
    CheckpointPending,
    /// Markdown committed, but recovery retirement failed. Apply `result`'s
    /// complete mutation even though the checkpoint needs a retry.
    CheckpointCommitted {
        result: Box<FlushDraftResult>,
        error: String,
    },
}

impl std::fmt::Display for EditorStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for EditorStoreError {}

/// A store-owned recovery and save workflow. Its blocking operations belong on
/// the host's background worker, including append acceptance before display.
pub struct StoreEditorSession<'store> {
    store: &'store LocalNoteStore,
    id: String,
    recovery: RecoveryLog,
    engine: EditorSession,
    lease: EditorLease,
    pending_checkpoint: Option<FlushDraftResult>,
}

impl LocalNoteStore {
    pub fn open_editor(&self, id: &str) -> Result<StoreEditorSession<'_>, EditorStoreError> {
        let _gate = self.lock_gate().map_err(EditorStoreError::Open)?;
        paths::note_path(&self.root, id).map_err(EditorStoreError::Open)?;
        let lease = EditorLease::acquire(&self.root, id)?;
        let base = self
            .read_existing(id)
            .map_err(EditorStoreError::Open)?
            .ok_or_else(|| EditorStoreError::Open(NOTE_NOT_FOUND.to_owned()))?;
        let (recovery, engine) =
            RecoveryLog::open(&self.root, id, &base).map_err(EditorStoreError::Recovery)?;
        Ok(StoreEditorSession {
            store: self,
            id: id.to_owned(),
            engine,
            recovery,
            lease,
            pending_checkpoint: None,
        })
    }
}

impl StoreEditorSession<'_> {
    #[cfg(test)]
    pub(crate) fn set_append_hook(&mut self, hook: Box<dyn Fn(bool)>) {
        self.recovery.append_hook = Some(hook);
    }
    #[cfg(test)]
    pub(crate) fn set_retirement_failure(&mut self, fail: bool) {
        self.recovery.fail_retirement = fail;
    }
    pub fn source_text(&self) -> String {
        self.engine.source_text()
    }
    pub fn display_text(&self) -> String {
        self.engine.display_text()
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn revision(&self) -> Revision {
        self.engine.revision()
    }

    pub fn selection(&self) -> DisplayRange {
        self.engine.selection()
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.engine
            .select_utf16(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.engine
            .move_caret(expected, direction)
            .map_err(EditorStoreError::Editor)
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        let (range, inserted) = self
            .engine
            .decode_utf16_input(expected, range, inserted)
            .map_err(EditorStoreError::Editor)?;
        self.replace(expected, range, &inserted)
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .replace(expected, range, inserted, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(EditorStoreError::Editor)
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .undo(expected, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(EditorStoreError::Editor)
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .redo(expected, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(EditorStoreError::Editor)
    }

    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        let _gate = self
            .store
            .lock_gate()
            .map_err(EditorStoreError::Checkpoint)?;
        let _vault_mutation =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Checkpoint)?;
        let source = self.engine.source_text();
        // Opening/closing an unchanged note must not write its old bytes over
        // a peer change or mint a conflict copy for a draft that never existed.
        let result = if let Some(result) = &self.pending_checkpoint {
            result.clone()
        } else if source == self.recovery.base() {
            FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            }
        } else {
            self.store
                .flush_draft_locked(&self.id, self.recovery.base(), &source)
                .map_err(EditorStoreError::Checkpoint)?
        };
        let final_id = match &result.disposition {
            FlushDisposition::ParkedConflict { parked_id } => parked_id.clone(),
            _ => self.id.clone(),
        };
        self.pending_checkpoint = Some(result.clone());
        if source != self.recovery.base() {
            let relative = crate::note_filename(&final_id);
            futo_notes_core::files::vault_fs::sync_file(&self.store.root, &relative)
                .and_then(|()| {
                    futo_notes_core::files::vault_fs::sync_parent(&self.store.root, &relative)
                })
                .map_err(|error| EditorStoreError::CheckpointCommitted {
                    result: Box::new(result.clone()),
                    error,
                })?;
        }
        let next_lease = if final_id != self.id {
            Some(
                EditorLease::acquire(&self.store.root, &final_id).map_err(|error| {
                    EditorStoreError::CheckpointCommitted {
                        result: Box::new(result.clone()),
                        error: error.to_string(),
                    }
                })?,
            )
        } else {
            None
        };
        if let Err(error) =
            self.recovery
                .retire(&self.store.root, &final_id, &source, self.engine.revision())
        {
            return Err(EditorStoreError::CheckpointCommitted {
                result: Box::new(result),
                error,
            });
        }
        if let Some(lease) = next_lease {
            self.lease = lease;
            self.id = final_id;
        }
        self.pending_checkpoint = None;
        Ok(result)
    }
}
