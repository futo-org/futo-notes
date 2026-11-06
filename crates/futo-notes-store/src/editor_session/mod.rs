use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futo_notes_editor::{
    Affinity, CaretDirection, DisplayRange, DisplayUtf16Range, EditorError, EditorSession,
    InlineFormat, ProjectionSlice, Revision, SelectionChange, ViewChange,
};

use crate::{paths, FlushDraftResult, LocalNoteStore, NOTE_NOT_FOUND};

mod checkpoint;
mod clipboard;
mod clock;
mod composition;
mod facade;
mod find;
mod identity;
mod input;
mod lease;
mod links;
mod portable;
mod quick_open;
mod save;
mod tables;
mod tags;
pub use clock::EditorClock;
pub(crate) use identity::IdentityTransition;
use lease::EditorLease;
pub(crate) use lease::{refuse_attached, terminate_deleted};
pub use portable::StoreEditorHost;

/// Where the session stands relative to the markdown file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveStatus {
    /// The engine's current revision.
    pub revision: Revision,
    /// The revision last written to markdown (or the one the note opened at).
    pub saved: Revision,
    /// When the next save is due, in the injected clock's coordinates. `None`
    /// when nothing is unsaved. A host must call `save_if_due` on its worker;
    /// no timer runs inside this session.
    pub save_deadline: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorStoreError {
    Open(String),
    SessionAlreadyOpen,
    Editor(EditorError),
    /// The markdown write failed. Input is still accepted; the save is retried.
    Checkpoint(String),
    SessionDeleted,
}

impl std::fmt::Display for EditorStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for EditorStoreError {}

/// A store-owned editor attachment: in-memory edits, debounced markdown saves.
/// Its blocking operations belong on the host's background worker. Dropping a
/// session without `close` loses its unsaved edits, as a crash would.
pub struct StoreEditorSession<'store> {
    store: StoreHandle<'store>,
    state: Arc<Mutex<Attachment>>,
}

pub(super) struct Attachment {
    id: String,
    engine: EditorSession,
    lease: EditorLease,
    /// The markdown the file held when this draft last matched it.
    base: String,
    /// Merged bytes committed for a portable page that has not adopted them yet.
    pending_merge: Option<String>,
    clock: Arc<dyn EditorClock>,
    save: save::SaveSchedule,
    terminal: bool,
    coordinated: Vec<ViewChange>,
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
        self.open_editor_with_clock(id, Arc::new(clock::MonotonicClock::default()))
    }

    pub fn open_editor_with_clock(
        &self,
        id: &str,
        clock: Arc<dyn EditorClock>,
    ) -> Result<StoreEditorSession<'_>, EditorStoreError> {
        StoreEditorSession::open(StoreHandle::Borrowed(self), id, clock)
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
            Arc::new(clock::MonotonicClock::default()),
        )
    }
}

impl<'store> StoreEditorSession<'store> {
    fn open(
        store: StoreHandle<'store>,
        id: &str,
        clock: Arc<dyn EditorClock>,
    ) -> Result<Self, EditorStoreError> {
        let _gate = store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault_mutation =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
        paths::note_path(&store.root, id).map_err(EditorStoreError::Open)?;
        let lease = EditorLease::acquire(&store.root, id)?;
        let base = store
            .read_existing(id)
            .map_err(EditorStoreError::Open)?
            .ok_or_else(|| EditorStoreError::Open(NOTE_NOT_FOUND.to_owned()))?;
        let mut engine =
            EditorSession::open_with_clock(&base, Arc::new(clock::GroupingClock(clock.clone())));
        // The engine starts without note ids; the store owns delivering them.
        engine.update_note_ids(&links::vault_note_ids(&store.root));
        let state = Arc::new(Mutex::new(Attachment {
            id: id.to_owned(),
            save: save::SaveSchedule::clean(engine.revision()),
            engine,
            lease,
            base,
            pending_merge: None,
            clock,
            terminal: false,
            coordinated: Vec::new(),
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
