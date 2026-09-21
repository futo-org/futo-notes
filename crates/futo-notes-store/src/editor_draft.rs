//! Baseline-aware editor identity changes. Ordinary CRUD remains in the store.
use super::{
    io_error, make_id, paths, sanitize_folder_path, split_id, vault, vault_fs,
    vault_mutation_guard, ErrorKind, FlushDisposition, LocalNoteStore, MutationResult,
};

impl LocalNoteStore {
    /// Save an editor snapshot and change its identity under one vault guard.
    /// A stale editor never overwrites the peer: its draft is parked at the
    /// requested destination, without redirecting links away from the peer.
    pub fn save_draft_as(
        &self,
        id: &str,
        wanted_id: &str,
        base: &str,
        content: &str,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        self.save_draft_as_locked(id, wanted_id, base, content)
    }

    fn save_draft_as_locked(
        &self,
        id: &str,
        wanted_id: &str,
        base: &str,
        content: &str,
    ) -> Result<MutationResult, String> {
        paths::note_path(&self.root, id)?;
        paths::note_path(&self.root, wanted_id)?;
        match self.read_note_file(id) {
            Ok(current) if current != base && current != content => {
                let parked = self.park_conflict_draft(wanted_id, content)?;
                if let Some(mutation) = parked.mutation {
                    return Ok(mutation);
                }
                let FlushDisposition::ParkedConflict { parked_id } = parked.disposition else {
                    unreachable!("park always returns a conflict disposition")
                };
                let metadata = vault::metadata(&self.root, &parked_id)
                    .ok_or_else(|| "parked draft metadata unavailable".to_owned())?;
                Ok(self.upsert_mutation(metadata))
            }
            Ok(current) => {
                if current != content {
                    self.write_raw(id, content, None)?;
                }
                self.rename_raw(id, wanted_id)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let metadata = self.install_new(wanted_id, content, None)?;
                Ok(self.upsert_mutation(metadata))
            }
            Err(error) => Err(io_error(error)),
        }
    }

    /// The editor move variant also owns optional folder creation.
    pub fn move_draft(
        &self,
        id: &str,
        folder: &str,
        base: &str,
        content: &str,
        create_folder: bool,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        let folder = sanitize_folder_path(folder);
        let (_, title) = split_id(id);
        if create_folder {
            paths::folder_path(&self.root, &folder)?;
            vault_fs::create_dir(&self.root, &folder)?;
        }
        let result = self.save_draft_as_locked(id, &make_id(&folder, &title), base, content);
        if result.is_err() && create_folder {
            let _ = vault_fs::remove_dir(&self.root, &folder, false);
        }
        result
    }
}
