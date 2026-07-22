use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_store as store;

use super::{
    ConditionalWrite, CreateOutcome, NoteBootstrap, NoteError, NoteMutation, NoteSnapshot,
    SearchHit,
};

#[derive(uniffi::Object)]
pub struct NoteStore {
    inner: store::LocalNoteStore,
}

#[uniffi::export]
impl NoteStore {
    #[uniffi::constructor]
    pub fn new(notes_root: String) -> Arc<Self> {
        Arc::new(Self {
            inner: store::LocalNoteStore::new(PathBuf::from(notes_root)),
        })
    }

    /// Search startup is best effort so index availability never gates the note snapshot.
    pub fn bootstrap(&self, index_dir: String) -> Result<NoteBootstrap, NoteError> {
        self.inner
            .bootstrap_with_search(PathBuf::from(index_dir), Arc::new(|_| {}))
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn scan(&self) -> NoteSnapshot {
        self.inner.snapshot().into()
    }

    pub fn read(&self, id: String) -> String {
        self.inner.read(&id)
    }

    pub fn exists(&self, id: String) -> bool {
        self.inner.exists(&id)
    }

    pub fn write(&self, id: String, content: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .write(&id, &content, None)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Skips stale or missing notes, but is not a true filesystem CAS.
    pub fn write_if_unchanged(
        &self,
        id: String,
        expected_prev: String,
        content: String,
    ) -> Result<ConditionalWrite, NoteError> {
        self.inner
            .write_if_unchanged(&id, &expected_prev, &content)
            .map(|result| ConditionalWrite {
                outcome: result.outcome.into(),
                mutation: result.mutation.map(Into::into),
            })
            .map_err(NoteError::Io)
    }

    /// Uses no-replace installation so a concurrent live-sync writer cannot be overwritten.
    pub fn create_if_absent(
        &self,
        id: String,
        content: String,
    ) -> Result<CreateOutcome, NoteError> {
        self.inner
            .create_if_absent(&id, &content)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn create_note(
        &self,
        title: String,
        folder: String,
        content: String,
    ) -> Result<NoteMutation, NoteError> {
        self.inner
            .create(&folder, &title, &content)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn delete(&self, id: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .delete(&id)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn rename(&self, old_id: String, new_id: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .rename(&old_id, &new_id)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn move_note(&self, id: String, folder: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .move_note(&id, &folder)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn create_folder(&self, path: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .create_folder(&path)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn rename_folder(&self, from: String, to: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .rename_folder(&from, &to)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Moves contained notes to the parent and rewrites their links before removing the folder.
    pub fn delete_folder(&self, folder: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .delete_folder(&folder)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn reset(&self) -> Result<(), NoteError> {
        self.inner.reset().map_err(NoteError::Io)
    }

    pub fn search(&self, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>, NoteError> {
        self.inner
            .search(&query, limit.map(|value| value as usize))
            .map(|hits| hits.into_iter().map(Into::into).collect())
            .map_err(NoteError::Io)
    }

    /// Bounded, engine-owned wait for keyword readiness (replaces the former
    /// per-shell poll loops). Blocking — call off the main thread, exactly
    /// like `search`.
    pub fn wait_until_search_ready(&self, timeout_ms: u64) -> bool {
        self.inner.wait_until_search_ready(timeout_ms)
    }

    pub fn rescan(&self) {
        self.inner.rebuild_search();
    }
}
