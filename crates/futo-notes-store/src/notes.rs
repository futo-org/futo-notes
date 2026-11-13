//! Single-note workflows: reads, external-change projection, create, write, rename, move, delete.

use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use futo_notes_core::files::{vault_fs, vault_mutation_guard};
use futo_notes_model::{make_id, sanitize_folder_path, split_id};

use crate::relink::prune_empty_parents;
use crate::{
    io_error, is_markdown_path, note_filename, paths, vault, FileChange, LocalNoteStore,
    MutationResult, NoteRename, Snapshot, VaultFile,
};

impl LocalNoteStore {
    pub fn snapshot(&self) -> Snapshot {
        vault::snapshot_with_cache(&self.root, &self.list_cache, self.sort_order())
    }

    pub fn inventory(&self) -> Vec<VaultFile> {
        vault::inventory(&self.root)
    }

    /// A missing note reads as empty (a broken wikilink opens through the
    /// ordinary path and is created on its first save). A note that exists but
    /// cannot be read or decoded is an error, never an empty note: answering ""
    /// opened it as a blank page whose every save then failed.
    pub fn read(&self, id: &str) -> Result<String, String> {
        Ok(self.read_existing(id)?.unwrap_or_default())
    }

    pub fn read_existing(&self, id: &str) -> Result<Option<String>, String> {
        paths::note_path(&self.root, id)?;
        vault_fs::read_optional(&self.root, &note_filename(id))?
            .map(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
            .transpose()
    }

    pub(crate) fn read_note_file(&self, id: &str) -> std::io::Result<String> {
        self.read_existing(id)
            .map_err(std::io::Error::other)?
            .ok_or_else(|| std::io::Error::from(ErrorKind::NotFound))
    }

    pub fn exists(&self, id: &str) -> bool {
        paths::note_path(&self.root, id)
            .map(|path| path.is_file())
            .unwrap_or(false)
    }

    /// Project a sync engine's reported filesystem changes into the complete
    /// mutation native shells need for their note-list caches.
    ///
    /// Metadata is gathered only for affected final ids. `finish_mutation`
    /// supplies Rust-owned positions and folders, so shells never rescan every
    /// note or duplicate the canonical ordering rule.
    pub fn refresh_external_changes(
        &self,
        updated_ids: &[String],
        deleted_ids: &[String],
        renamed: &[NoteRename],
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;

        // Prepare every attachment before changing any identity. A failed
        // destination lease/read keeps all drafts attached for a retry.
        let mut transitions = Vec::new();
        for pair in renamed {
            paths::note_path(&self.root, &pair.from)?;
            paths::note_path(&self.root, &pair.to)?;
            if let Some(transition) = crate::editor_session::IdentityTransition::prepare_external(
                &self.root,
                &pair.from,
                &pair.to,
                deleted_ids,
            )? {
                transitions.push(transition);
            }
        }
        for transition in transitions {
            transition.finish();
        }

        let mut affected_ids = Vec::new();
        let mut seen = HashSet::new();
        for id in updated_ids
            .iter()
            .chain(deleted_ids)
            .chain(renamed.iter().flat_map(|pair| [&pair.from, &pair.to]))
        {
            if seen.insert(id.as_str()) {
                affected_ids.push(id);
            }
        }

        let mut notes = Vec::new();
        let mut removed = Vec::new();
        for id in affected_ids {
            match vault::metadata(&self.root, id) {
                Some(metadata) => {
                    self.search.notify(&FileChange::Changed(note_filename(id)));
                    notes.push(metadata);
                }
                None => {
                    self.search.notify(&FileChange::Removed(note_filename(id)));
                    // The pull vacated this note's directory exactly as a local
                    // delete or move would, so it gets the same cleanup — the
                    // gone note's now-empty ancestors, nothing else. Without it
                    // every peer that syncs a folder deletion keeps the emptied
                    // directory forever in the reported `folders`.
                    if let Ok(path) = paths::note_path(&self.root, id) {
                        prune_empty_parents(&self.root, &path);
                    }
                    removed.push(id.clone());
                }
            }
        }
        Ok(self.finish_mutation(
            notes,
            MutationResult {
                removed,
                renamed: renamed.to_vec(),
                ..MutationResult::default()
            },
        ))
    }

    /// Appends `text` verbatim to an existing note as one check-and-write span,
    /// so two appenders each land exactly once and neither overwrites the
    /// other. No separator is added. A missing note is [`crate::NOTE_NOT_FOUND`];
    /// an empty append writes nothing and reports the note as it is.
    pub fn append(&self, id: &str, text: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        let current = self
            .read_existing(id)?
            .ok_or_else(|| crate::NOTE_NOT_FOUND.to_owned())?;
        if text.is_empty() {
            let metadata =
                vault::metadata(&self.root, id).ok_or_else(|| crate::NOTE_NOT_FOUND.to_owned())?;
            return Ok(self.upsert_mutation(metadata));
        }
        let metadata = self.write_raw(id, &(current + text), None)?;
        Ok(self.upsert_mutation(metadata))
    }

    pub fn create(
        &self,
        folder: &str,
        title: &str,
        content: &str,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        let metadata = self.install_new(&make_id(folder, title), content, None)?;
        Ok(self.upsert_mutation(metadata))
    }

    /// Copy one external Markdown file into the vault as a new root note.
    ///
    /// The source filename is the title (M2): only the Markdown extension is
    /// removed, and the normal collision allocator chooses a suffix rather
    /// than overwriting an existing note. The source file is read-only input,
    /// and its bytes are copied as they are.
    pub fn import_markdown(&self, source: &Path) -> Result<MutationResult, String> {
        if !is_markdown_path(source) {
            return Err("only .md and .markdown files can be imported".to_owned());
        }
        if !source.is_file() {
            return Err("Markdown import source is not a regular file".to_owned());
        }
        let title = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Markdown import source has no usable filename".to_owned())?;
        let content = fs::read_to_string(source).map_err(io_error)?;

        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        let metadata = self.install_new(&make_id("", title), &content, None)?;
        Ok(self.upsert_mutation(metadata))
    }

    pub fn write(
        &self,
        id: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        let metadata = self.write_raw(id, content, modified_ms)?;
        Ok(self.upsert_mutation(metadata))
    }
}

impl LocalNoteStore {
    pub fn rename(&self, old_id: &str, wanted_id: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        self.rename_raw(old_id, wanted_id)
    }

    pub fn move_note(&self, id: &str, folder: &str) -> Result<MutationResult, String> {
        let (_, title) = split_id(id);
        let folder = sanitize_folder_path(folder);
        let wanted = if folder.is_empty() {
            title
        } else {
            format!("{folder}/{title}")
        };
        self.rename(id, &wanted)
    }

    /// A pending rename that ended at the deleted `id` is over: a later note
    /// at that name must not inherit the moved note's sync identity.
    fn forget_rename_into(&self, id: &str) -> Option<String> {
        crate::rename_journal::forget_deleted_locked(&self.root, &note_filename(id))
            .err()
            .map(|error| format!("deleted, but the rename journal kept its intent: {error}"))
    }

    pub fn delete(&self, id: &str) -> Result<MutationResult, String> {
        self.delete_with(id, |_| {
            vault_fs::remove_local(&self.root, &note_filename(id)).map(|_| ())
        })
    }

    /// Delete `id` only if its file is still empty, checked under the mutation gate: a note
    /// someone wrote to meanwhile is kept and the result changes nothing.
    pub fn delete_if_empty(&self, id: &str) -> Result<MutationResult, String> {
        self.delete_checked(
            id,
            |_| vault_fs::remove_local(&self.root, &note_filename(id)).map(|_| ()),
            || Ok(self.read_existing(id)?.is_none_or(|body| body.is_empty())),
        )
    }

    pub fn delete_with<F>(&self, id: &str, remove: F) -> Result<MutationResult, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        self.delete_checked(id, remove, || Ok(true))
    }

    fn delete_checked<F, G>(
        &self,
        id: &str,
        remove: F,
        may_delete: G,
    ) -> Result<MutationResult, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
        G: FnOnce() -> Result<bool, String>,
    {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        if !may_delete()? {
            return Ok(self.finish_mutation(Vec::new(), MutationResult::default()));
        }
        let path = paths::note_path(&self.root, id)?;
        if !path.exists() {
            let journal_warning = self.forget_rename_into(id);
            // Already gone (an outside delete): still end an attached editor,
            // or its next save would recreate the note.
            crate::editor_session::terminate_deleted(&self.root, id)?;
            return Ok(self.finish_mutation(
                Vec::new(),
                MutationResult {
                    warnings: journal_warning.into_iter().collect(),
                    ..MutationResult::default()
                },
            ));
        }
        let change = FileChange::Removed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        remove(&path)?;
        let journal_warning = self.forget_rename_into(id);
        // The file is gone: an attached editor's draft is discarded with it.
        crate::editor_session::terminate_deleted(&self.root, id)?;
        prune_empty_parents(&self.root, &path);
        self.search.notify(&change);
        Ok(self.finish_mutation(
            Vec::new(),
            MutationResult {
                removed: vec![id.to_owned()],
                warnings: journal_warning.into_iter().collect(),
                ..MutationResult::default()
            },
        ))
    }
}
