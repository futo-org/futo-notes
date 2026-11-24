//! Baseline-aware editor identity changes. Ordinary CRUD remains in the store.
use super::{
    io_error, make_id, paths, sanitize_folder_path, split_id, vault, vault_mutation_guard,
    ErrorKind, FlushDisposition, LocalNoteStore, MutationResult,
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
        Ok(self.save_draft_as_locked(id, wanted_id, base, content)?.1)
    }

    /// Caller holds the store gate and the vault mutation guard. Only the
    /// rename arm moves a matching attachment (`IdentityTransition`); after a
    /// park or a recreate the caller follows it (`StoreEditorSession::rename_title`).
    pub(crate) fn save_draft_as_locked(
        &self,
        id: &str,
        wanted_id: &str,
        base: &str,
        content: &str,
    ) -> Result<(FlushDisposition, MutationResult), String> {
        paths::note_path(&self.root, id)?;
        paths::note_path(&self.root, wanted_id)?;
        // An explicit move may create its requested destination folder. A title
        // rename, including a filesystem alias of the same folder, must not
        // resurrect a parent moved outside the app.
        let create_destination_parent = !paths::same_note_parent(id, wanted_id);
        match self.read_note_file(id) {
            Ok(current) if current != base && current != content => {
                let parked = self.park_draft_with_parent_policy(
                    wanted_id,
                    content,
                    create_destination_parent,
                )?;
                let FlushDisposition::ParkedConflict { parked_id } = &parked.disposition else {
                    unreachable!("park always returns a conflict disposition")
                };
                let mutation = match parked.mutation {
                    Some(mutation) => mutation,
                    None => self.upsert_mutation(
                        vault::metadata(&self.root, parked_id)
                            .ok_or_else(|| "parked draft metadata unavailable".to_owned())?,
                    ),
                };
                Ok((parked.disposition, mutation))
            }
            Ok(current) => {
                let disposition = if current == content {
                    FlushDisposition::Converged
                } else {
                    self.write_draft_raw(id, content, None)?;
                    FlushDisposition::Wrote
                };
                Ok((disposition, self.rename_raw(id, wanted_id)?))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let metadata = self.install_with_parent_policy(
                    wanted_id,
                    content,
                    None,
                    create_destination_parent,
                )?;
                Ok((FlushDisposition::Recreated, self.upsert_mutation(metadata)))
            }
            Err(error) => Err(io_error(error)),
        }
    }

    /// The editor's move: its draft saved under the note's id in `folder`.
    pub fn move_draft(
        &self,
        id: &str,
        folder: &str,
        base: &str,
        content: &str,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        let folder = sanitize_folder_path(folder);
        let (_, title) = split_id(id);
        Ok(self
            .save_draft_as_locked(id, &make_id(&folder, &title), base, content)?
            .1)
    }
}
