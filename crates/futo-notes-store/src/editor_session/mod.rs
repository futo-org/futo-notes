use std::sync::Arc;
use std::time::Duration;

use futo_notes_editor::{
    Affinity, CaretDirection, DisplayRange, DisplayUtf16Range, EditorError, EditorSession,
    InlineFormat, ProjectionSlice, Revision, SelectionChange, ViewChange,
};

use crate::{paths, FlushDisposition, FlushDraftResult, LocalNoteStore, NOTE_NOT_FOUND};

mod clock;
mod input;
mod lease;
pub use clock::RecoveryClock;
mod portable;
mod recovery;
mod recovery_format;
pub use portable::StoreEditorHost;
mod storage;
use lease::EditorLease;
use recovery::RecoveryLog;
pub use storage::RecoveryStorage;

/// Storage and time dependencies below the public editor/store workflow.
/// Default construction uses the vault's guarded filesystem and monotonic time.
pub struct RecoveryOptions {
    pub clock: Arc<dyn RecoveryClock>,
    pub storage: Box<dyn RecoveryStorage>,
}

impl Default for RecoveryOptions {
    fn default() -> Self {
        Self {
            clock: Arc::new(clock::MonotonicClock::default()),
            storage: Box::new(storage::VaultRecoveryStorage::default()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryStatus {
    /// Last OS-accepted edit in this session (including Undo/Redo).
    pub accepted: Revision,
    /// Last edit protected by a successful recovery flush or checkpoint.
    /// These are session watermarks, not a markdown-saved flag. Reopening a log
    /// conservatively requires another flush to acknowledge recovered records.
    pub durable: Revision,
    /// Deadline in the injected monotonic clock's coordinates. A host must run
    /// `flush_recovery_if_due` on its worker; no timer runs inside this session.
    pub flush_deadline: Option<Duration>,
    pub paused: bool,
    /// Completion after the target deadline, including storage latency. Failed
    /// flushes do not update this measurement or acknowledge durability.
    pub last_flush_lateness: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryIssueKind {
    TornTail,
    CorruptRecord,
    InvalidEdit,
    SequenceMismatch,
    IdentityMismatch,
    UnsupportedVersion { version: u32 },
    BaseMismatch,
}

/// A retained stream needs attention. `record` is zero for the header and
/// one-based for edits. The session exposes only its validated draft prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryIssue {
    pub kind: RecoveryIssueKind,
    pub record: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorStoreError {
    Open(String),
    SessionAlreadyOpen,
    Editor(EditorError),
    Recovery(String),
    RecoveryAppend(String),
    RecoveryFlush(String),
    RecoveryResume(String),
    RecoveryPaused,
    RecoveryNeedsReview(RecoveryIssue),
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
    store: StoreHandle<'store>,
    id: String,
    recovery: RecoveryLog,
    engine: EditorSession,
    lease: EditorLease,
    pending_checkpoint: Option<FlushDraftResult>,
}

// Owning foreign sessions retain the same store and its coordination state;
// ordinary Rust callers can continue borrowing it without allocation.
enum StoreHandle<'store> {
    Borrowed(&'store LocalNoteStore),
    Owned(Arc<LocalNoteStore>),
}

impl std::ops::Deref for StoreHandle<'_> {
    type Target = LocalNoteStore;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Borrowed(store) => store,
            Self::Owned(store) => store,
        }
    }
}

impl LocalNoteStore {
    pub fn open_editor(&self, id: &str) -> Result<StoreEditorSession<'_>, EditorStoreError> {
        self.open_editor_with_recovery(id, RecoveryOptions::default())
    }

    pub fn open_editor_with_recovery(
        &self,
        id: &str,
        options: RecoveryOptions,
    ) -> Result<StoreEditorSession<'_>, EditorStoreError> {
        StoreEditorSession::open(StoreHandle::Borrowed(self), id, options)
    }

    /// Retains this store for a foreign worker/session lifetime without borrowing
    /// a movable facade or creating another independent store instance.
    pub fn open_owned_editor(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<StoreEditorSession<'static>, EditorStoreError> {
        StoreEditorSession::open(
            StoreHandle::Owned(Arc::clone(self)),
            id,
            RecoveryOptions::default(),
        )
    }
}

impl<'store> StoreEditorSession<'store> {
    fn open(
        store: StoreHandle<'store>,
        id: &str,
        options: RecoveryOptions,
    ) -> Result<Self, EditorStoreError> {
        let _gate = store.lock_gate().map_err(EditorStoreError::Open)?;
        paths::note_path(&store.root, id).map_err(EditorStoreError::Open)?;
        let lease = EditorLease::acquire(&store.root, id)?;
        let base = store
            .read_existing(id)
            .map_err(EditorStoreError::Open)?
            .ok_or_else(|| EditorStoreError::Open(NOTE_NOT_FOUND.to_owned()))?;
        let (mut recovery, engine) =
            RecoveryLog::open(&store.root, id, &base, options.clock, options.storage)
                .map_err(EditorStoreError::Recovery)?;
        // A durable destination precedes installation. If its exact draft is
        // present after a crash, finish that checkpoint instead of re-running
        // date-sensitive parking and minting another conflict copy.
        let pending_checkpoint = if !recovery.failed {
            if let Some(target) = &recovery.checkpoint_target {
                let source = engine.source_text();
                if store
                    .read_existing(target)
                    .map_err(EditorStoreError::Open)?
                    .as_deref()
                    == Some(source.as_str())
                {
                    let metadata =
                        crate::vault::metadata(&store.root, target).ok_or_else(|| {
                            EditorStoreError::Open("checkpoint target metadata unavailable".into())
                        })?;
                    let result = FlushDraftResult {
                        disposition: if target == id {
                            FlushDisposition::Converged
                        } else {
                            FlushDisposition::ParkedConflict {
                                parked_id: target.clone(),
                            }
                        },
                        mutation: Some(store.upsert_mutation(metadata)),
                    };
                    recovery.issue = None;
                    Some(result)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        drop(_gate);
        Ok(StoreEditorSession {
            store,
            id: id.to_owned(),
            engine,
            recovery,
            lease,
            pending_checkpoint,
        })
    }
}

impl StoreEditorSession<'_> {
    #[cfg(test)]
    pub(crate) fn set_append_hook(&mut self, hook: Box<dyn Fn(bool) + Send>) {
        self.recovery.append_hook = Some(hook);
    }
    #[cfg(test)]
    pub(crate) fn set_retirement_failure(&mut self, fail: bool) {
        self.recovery.fail_retirement = fail;
    }
    pub fn recovery_issue(&self) -> Option<&RecoveryIssue> {
        self.recovery.issue.as_ref()
    }

    pub fn recovery_status(&self) -> RecoveryStatus {
        RecoveryStatus {
            accepted: self.recovery.accepted,
            durable: self.recovery.durable,
            flush_deadline: self.recovery.flush_deadline,
            paused: self.recovery.failed || self.pending_checkpoint.is_some(),
            last_flush_lateness: self.recovery.last_flush_lateness,
        }
    }

    pub fn flush_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        self.recovery
            .flush(&self.store.root)
            .map_err(EditorStoreError::RecoveryFlush)?;
        Ok(self.recovery_status())
    }

    /// Time remaining until the oldest unflushed edit's target, usable even
    /// with the default clock whose origin is private to this session.
    pub fn recovery_flush_delay(&self) -> Option<Duration> {
        self.recovery.flush_delay()
    }

    /// Run on the host's background worker when `flush_deadline` is reached.
    /// A delayed worker flushes late; it never fabricates an on-time acknowledgement.
    pub fn flush_recovery_if_due(&mut self) -> Result<bool, EditorStoreError> {
        if !self.recovery.flush_due() {
            return Ok(false);
        }
        self.flush_recovery()?;
        Ok(true)
    }

    pub fn resume_recovery(&mut self) -> Result<RecoveryStatus, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        let _gate = self
            .store
            .lock_gate()
            .map_err(EditorStoreError::RecoveryResume)?;
        if let Some(issue) = &self.recovery.issue {
            if issue.kind != RecoveryIssueKind::TornTail
                && issue.kind != RecoveryIssueKind::BaseMismatch
            {
                return Err(EditorStoreError::RecoveryNeedsReview(issue.clone()));
            }
        }
        if self.recovery.failed {
            self.recovery
                .resume(&self.store.root)
                .map_err(EditorStoreError::RecoveryResume)?;
        } else {
            // A host may be healthy while its append acknowledgement was lost.
            // Resolve resume + flush under one gate before unpausing its page.
            self.recovery
                .flush(&self.store.root)
                .map_err(EditorStoreError::RecoveryResume)?;
        }
        Ok(self.recovery_status())
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

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        self.engine.active_formats()
    }

    pub fn selection(&self) -> DisplayRange {
        self.engine.selection()
    }

    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorStoreError> {
        self.engine
            .check_revision(expected)
            .map_err(EditorStoreError::Editor)
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: futo_notes_editor::DisplayOffset,
        affinity: Affinity,
    ) -> Result<futo_notes_editor::SourceOffset, EditorStoreError> {
        self.engine
            .source_at(expected, offset, affinity)
            .map_err(EditorStoreError::Editor)
    }

    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorStoreError> {
        self.engine
            .display_to_utf16(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorStoreError> {
        self.engine
            .project(expected, range)
            .map_err(EditorStoreError::Editor)
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.engine
            .select_with_affinity(expected, range, affinity)
            .map_err(EditorStoreError::Editor)
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .toggle_format(expected, format, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(EditorStoreError::Editor)
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

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .undo(expected, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        if self.pending_checkpoint.is_some() {
            return Err(EditorStoreError::CheckpointPending);
        }
        if self.recovery.failed {
            return Err(EditorStoreError::RecoveryPaused);
        }
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
        self.engine
            .redo(expected, &mut |edit| {
                self.recovery.append(&self.store.root, edit)
            })
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
    }

    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        if let Some(issue) = &self.recovery.issue {
            if issue.kind != RecoveryIssueKind::BaseMismatch {
                return Err(EditorStoreError::RecoveryNeedsReview(issue.clone()));
            }
        }
        if self.recovery.failed && self.pending_checkpoint.is_none() {
            return Err(EditorStoreError::RecoveryPaused);
        }
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
            let base = self.recovery.base().to_owned();
            self.store
                .flush_draft_locked_with_target(&self.id, &base, &source, &mut |id| {
                    self.recovery.protect_checkpoint(&self.store.root, id)
                })
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
