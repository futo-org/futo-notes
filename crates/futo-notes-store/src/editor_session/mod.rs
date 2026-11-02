use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futo_notes_editor::{
    Affinity, CaretDirection, DisplayRange, DisplayUtf16Range, EditorError, EditorSession,
    InlineFormat, ProjectionSlice, Revision, SelectionChange, ViewChange,
};

use crate::{paths, FlushDisposition, FlushDraftResult, LocalNoteStore, NOTE_NOT_FOUND};

mod checkpoint;
mod clipboard;
mod clock;
mod composition;
pub(crate) mod deletion;
mod facade;
mod find;
mod identity;
mod input;
mod links;
mod state;
mod tables;
mod tags;
pub(crate) use identity::IdentityTransition;
mod lease;
pub use clock::RecoveryClock;
mod portable;
mod recovery;
mod recovery_format;
pub use portable::StoreEditorHost;
mod storage;
pub(crate) use lease::refuse_attached;
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
    SessionDeleted,
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
    state: Arc<Mutex<Attachment>>,
}

pub(super) struct Attachment {
    id: String,
    recovery: RecoveryLog,
    engine: EditorSession,
    lease: EditorLease,
    pending_checkpoint: Option<FlushDraftResult>,
    terminal: bool,
    coordinated: Vec<ViewChange>,
    pending_identity: Option<identity::PendingIdentity>,
    portable: bool,
    relink_offer: Option<futo_notes_editor::RelinkOffer>,
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
        mut options: RecoveryOptions,
    ) -> Result<Self, EditorStoreError> {
        let _gate = store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault_mutation =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
        paths::note_path(&store.root, id).map_err(EditorStoreError::Open)?;
        let lease = EditorLease::acquire(&store.root, id)?;
        deletion::recover_with_storage(&store.root, id, &mut *options.storage)
            .map_err(EditorStoreError::Recovery)?;
        RecoveryLog::recover_identities(&store.root, id, &mut *options.storage)
            .map_err(EditorStoreError::Recovery)?;
        let base = store
            .read_existing(id)
            .map_err(EditorStoreError::Open)?
            .ok_or_else(|| EditorStoreError::Open(NOTE_NOT_FOUND.to_owned()))?;
        let (mut recovery, mut engine) =
            RecoveryLog::open(&store.root, id, &base, options.clock, options.storage)
                .map_err(EditorStoreError::Recovery)?;
        // The engine starts without note ids; the store owns delivering them.
        engine.update_note_ids(&links::vault_note_ids(&store.root));
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
        let state = Arc::new(Mutex::new(Attachment {
            id: id.to_owned(),
            engine,
            recovery,
            lease,
            pending_checkpoint,
            terminal: false,
            coordinated: Vec::new(),
            pending_identity: None,
            portable: false,
            relink_offer: None,
        }));
        state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .lease
            .bind(&state);
        drop(_gate);
        Ok(StoreEditorSession { store, state })
    }
}
