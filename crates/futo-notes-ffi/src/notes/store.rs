use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_store as store;

use crate::RenamePair;

use super::{
    FlushDraftResult, MergedDraftResult, NoteBootstrap, NoteError, NoteMutation, NoteSnapshot,
    NoteSortOrder, SearchHit, VaultDestinationInspection, VaultMigrationFinalization,
    VaultMigrationOutcome,
};

#[derive(uniffi::Object)]
pub struct NoteStore {
    inner: Arc<store::LocalNoteStore>,
}

impl NoteStore {
    /// Project a workflow result for the shells. When the workflow rewrote the
    /// final note's own links, the shells also need the bytes it left: an open
    /// editor's baseline is what the file now holds, not what it last wrote.
    fn project(&self, mutation: store::MutationResult) -> NoteMutation {
        let body = mutation
            .final_id
            .as_ref()
            .filter(|id| mutation.relinked.contains(id))
            .and_then(|id| self.inner.read(id).ok());
        let mut projected = NoteMutation::from(mutation);
        projected.final_body = body;
        projected
    }
}

#[uniffi::export]
impl NoteStore {
    #[uniffi::constructor]
    pub fn new(notes_root: String) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(store::LocalNoteStore::new(PathBuf::from(notes_root))),
        })
    }

    pub fn open_editor(
        &self,
        id: String,
    ) -> Result<Arc<crate::NativeEditorSession>, crate::EditorSessionError> {
        crate::NativeEditorSession::open(&self.inner, &id)
    }

    /// A long note's first screens, to show read-only while `open_editor`
    /// runs; `None` for a short note, one with no safe cut, or a failed read
    /// (the whole open then reports it). Blocking file I/O.
    pub fn quick_open_editor(&self, id: String) -> Option<crate::EditorQuickOpen> {
        self.inner
            .quick_open_editor(&id)
            .ok()
            .flatten()
            .map(Into::into)
    }

    /// Read a note once for its editor: `quick_open_view` takes these bytes, and so does
    /// `open_editor_read` once they were shown, so input made on the first screens applies to
    /// the text it was made on (#392). A failed read has no first screens; the open reports it.
    /// Blocking file I/O.
    pub fn read_for_editor(&self, id: String) -> Arc<crate::EditorNoteRead> {
        Arc::new(crate::EditorNoteRead(self.inner.read_for_editor(&id)))
    }

    /// The first screens of `read` (`quick_open_editor`), with their spans planned in UTF-16
    /// units (`host::plan_quick_open`); `None` for a short note or one with no safe cut.
    pub fn quick_open_view(
        &self,
        read: Arc<crate::EditorNoteRead>,
    ) -> Option<crate::EditorQuickView> {
        self.inner.quick_open_read(&read.0).map(Into::into)
    }

    /// `open_editor`, on the bytes `read` holds when its first screens were shown (take them
    /// first). A write since is then merged or parked by the session's first save, which is due
    /// at once.
    pub fn open_editor_read(
        &self,
        read: Arc<crate::EditorNoteRead>,
    ) -> Result<Arc<crate::NativeEditorSession>, crate::EditorSessionError> {
        crate::NativeEditorSession::open_read(&self.inner, &read.0)
    }

    /// Search startup is best effort so index availability never gates the note snapshot.
    pub fn bootstrap(
        &self,
        index_dir: String,
        order: NoteSortOrder,
    ) -> Result<NoteBootstrap, NoteError> {
        self.inner
            .bootstrap_with_search_in_order(
                order.into(),
                PathBuf::from(index_dir),
                Arc::new(|_| {}),
            )
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn set_sort_order(&self, order: NoteSortOrder) -> Result<NoteSnapshot, NoteError> {
        self.inner
            .set_sort_order(order.into())
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn scan(&self) -> NoteSnapshot {
        self.inner.snapshot().into()
    }

    /// A missing note reads as empty; one that exists but cannot be decoded is
    /// an error, so the editor never opens it as a blank page.
    pub fn read(&self, id: String) -> Result<String, NoteError> {
        self.inner.read(&id).map_err(NoteError::Io)
    }

    pub fn read_if_exists(&self, id: String) -> Result<Option<String>, NoteError> {
        self.inner.read_existing(&id).map_err(NoteError::Io)
    }

    pub fn exists(&self, id: String) -> bool {
        self.inner.exists(&id)
    }

    pub fn refresh_external_changes(
        &self,
        updated_ids: Vec<String>,
        deleted_ids: Vec<String>,
        renamed: Vec<RenamePair>,
    ) -> Result<NoteMutation, NoteError> {
        let renamed = renamed
            .into_iter()
            .map(|pair| store::NoteRename {
                from: pair.from_id,
                to: pair.to_id,
            })
            .collect::<Vec<_>>();
        self.inner
            .refresh_external_changes(&updated_ids, &deleted_ids, &renamed)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn write(&self, id: String, content: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .write(&id, &content, None)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// THE draft-saving verb (persist-or-park, ADR-0001 / issue #37): the
    /// whole wrote/converged/recreated/parked composition runs under the
    /// engine's per-workflow serialization, so shells never stitch the raw
    /// primitives together across FFI calls.
    pub fn flush_draft(
        &self,
        id: String,
        base: String,
        content: String,
    ) -> Result<FlushDraftResult, NoteError> {
        self.inner
            .flush_draft(&id, &base, &content)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Merge-aware saving for consumers that adopt authoritative source safely.
    pub fn flush_draft_merged(
        &self,
        id: String,
        base: String,
        content: String,
    ) -> Result<MergedDraftResult, NoteError> {
        self.inner
            .flush_draft_merged(&id, &base, &content)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn save_draft_as(
        &self,
        id: String,
        wanted_id: String,
        base: String,
        content: String,
    ) -> Result<NoteMutation, NoteError> {
        self.inner
            .save_draft_as(&id, &wanted_id, &base, &content)
            .map(|mutation| self.project(mutation))
            .map_err(NoteError::Io)
    }

    pub fn move_draft(
        &self,
        id: String,
        folder: String,
        base: String,
        content: String,
    ) -> Result<NoteMutation, NoteError> {
        self.inner
            .move_draft(&id, &folder, &base, &content)
            .map(|mutation| self.project(mutation))
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

    /// Delete the note only if it is still empty when the gate is held; a note with
    /// content is kept and the mutation is empty.
    pub fn delete_if_empty(&self, id: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .delete_if_empty(&id)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn rename(&self, old_id: String, new_id: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .rename(&old_id, &new_id)
            .map(|mutation| self.project(mutation))
            .map_err(NoteError::Io)
    }

    pub fn move_note(&self, id: String, folder: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .move_note(&id, &folder)
            .map(|mutation| self.project(mutation))
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
            .map(|mutation| self.project(mutation))
            .map_err(NoteError::Io)
    }

    pub fn move_folder(
        &self,
        from: String,
        destination_parent: String,
    ) -> Result<NoteMutation, NoteError> {
        self.inner
            .move_folder(&from, &destination_parent)
            .map(|mutation| self.project(mutation))
            .map_err(NoteError::Io)
    }

    /// Moves contained notes to the parent and rewrites their links before removing the folder.
    pub fn delete_folder(&self, folder: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .delete_folder(&folder)
            .map(|mutation| self.project(mutation))
            .map_err(NoteError::Io)
    }

    pub fn reset(&self) -> Result<(), NoteError> {
        self.inner.reset().map_err(NoteError::Io)
    }

    pub fn inspect_vault_destination(&self, destination: String) -> VaultDestinationInspection {
        self.inner
            .inspect_vault_destination(&PathBuf::from(destination))
            .into()
    }

    pub fn stage_vault_migration(
        &self,
        destination: String,
    ) -> Result<VaultMigrationOutcome, NoteError> {
        self.inner
            .stage_vault_migration(&PathBuf::from(destination))
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn finalize_vault_migration(
        &self,
        destination: String,
        allow_source_removal: bool,
    ) -> Result<VaultMigrationFinalization, NoteError> {
        self.inner
            .finalize_vault_migration(&PathBuf::from(destination), allow_source_removal)
            .map(Into::into)
            .map_err(NoteError::Io)
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
