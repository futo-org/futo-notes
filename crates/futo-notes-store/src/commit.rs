//! Committing a mutation: no-replace installs, writes, recovered-backup parking, and the post-commit projection.

use std::collections::HashMap;
use std::fs;

use futo_notes_core::files::{collides_but_differs, now_ms, vault_fs};
use futo_notes_model::{make_id, split_id};

use crate::{
    io_error, note_filename, paths, vault, vault_name, FileChange, LocalNoteStore, MutationResult,
    NoteMetadata, UpsertedNote,
};

impl LocalNoteStore {
    /// A single-note upsert mutation: the note is its own primary, so its
    /// (collision-resolved) id is the mutation's final id.
    pub(crate) fn upsert_mutation(&self, metadata: NoteMetadata) -> MutationResult {
        let final_id = metadata.id.clone();
        self.finish_mutation(
            vec![metadata],
            MutationResult {
                final_id: Some(final_id),
                ..MutationResult::default()
            },
        )
    }

    /// Complete the authoritative shell projection while the mutation gate is
    /// held. Externally removed upserts fall back to the clamped list tail.
    pub(crate) fn finish_mutation(
        &self,
        notes: Vec<NoteMetadata>,
        mut mutation: MutationResult,
    ) -> MutationResult {
        let (order, folders) = vault::note_order_and_folders(&self.root, self.sort_order());
        let index: HashMap<&str, u32> = order
            .iter()
            .enumerate()
            .map(|(position, id)| (id.as_str(), position as u32))
            .collect();
        mutation.upserted = notes
            .into_iter()
            .map(|note| UpsertedNote {
                position: index
                    .get(note.id.as_str())
                    .copied()
                    .unwrap_or(order.len() as u32),
                note,
            })
            .collect();
        mutation.upserted.sort_by(|left, right| {
            left.position
                .cmp(&right.position)
                .then_with(|| left.note.id.cmp(&right.note.id))
        });
        mutation.folders = folders;
        mutation
    }

    /// Install a brand-new note at a collision-free id using a NO-REPLACE
    /// atomic create. The store mutex serializes only this process's mutations,
    /// NOT an external/sync writer, so between id allocation and install a file
    /// can appear at the chosen id. `create_new_atomic` fails (EEXIST) rather
    /// than overwriting; we re-allocate a fresh suffix — now seeing that file —
    /// and retry, so a create never silently clobbers a note this store did not
    /// write. (An overwrite install here is the A1 data-loss window.)
    ///
    /// A brand-new create registers NO watcher suppression (D2, two-strikes
    /// redesign of the create path): there was no fixed suppress-vs-install
    /// ordering that both hid our own echo and never ate a peer/collision event
    /// (B3 → C2 → D2). The own-create echo is instead made harmless — the
    /// desktop watcher's create reconcile is idempotent (the id is already in
    /// the cache with identical content, so `refreshNotesFromStorage` is a
    /// no-op mutation; no toast, no editor disturbance), and the collision case
    /// is automatically correct because the peer's event is processed normally
    /// (no suppression to eat it). Rename/delete/write-existing keep their
    /// pre-write suppression — those disturb a file the watcher already knows.
    pub(crate) fn install_new(
        &self,
        wanted: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<NoteMetadata, String> {
        for _ in 0..1000 {
            let id = paths::unique_note_id(&self.root, wanted, None)?;
            paths::note_path(&self.root, &id)?;
            #[cfg(test)]
            if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
                hook(&id);
            }
            if !vault_fs::create_new(&self.root, &note_filename(&id), content.as_bytes())? {
                // A writer outside this store's serialization took the id; the
                // write did not happen. Re-allocate against the now-larger tree
                // and retry — no suppression to unwind.
                continue;
            }
            self.stamp_note(&id, modified_ms)?;
            let metadata = vault::metadata(&self.root, &id)
                .ok_or_else(|| "note metadata unavailable after create".to_owned())?;
            self.search.notify(&FileChange::Changed(note_filename(&id)));
            return Ok(metadata);
        }
        Err("could not allocate a free note id after repeated collisions".to_owned())
    }

    /// Park a divergent recovered backup (see
    /// `futo_notes_core::files::recover_parked_backups`) as a visible
    /// "<title> (recovered)" note through the no-replace create path, then
    /// consume the backup file. This is a NEW note — it never overwrites the
    /// live note holding the original name, and the terminal backup can never
    /// resurrect a later-deleted note (C1).
    pub(crate) fn park_recovered_backup(
        &self,
        recovered: &futo_notes_core::files::RecoveredBackup,
    ) -> Result<(), String> {
        // Folder = the backup's directory relative to the vault root, so a
        // recovered note in a subfolder stays in that subfolder (D4).
        let folder = recovered
            .backup
            .parent()
            .and_then(|parent| vault_fs::relative_name(&self.root, parent))
            .unwrap_or_default();
        let title = futo_notes_core::files::note_id_from_filename(&recovered.leaf)
            .unwrap_or_else(|| recovered.leaf.clone());
        let stem = format!("{title} (recovered)");
        let wanted = make_id(&folder, &stem);
        // Idempotency (E2): a crash after the install but before the backup
        // unlink leaves the recovered note in place with the backup still
        // sidecar'd, so a re-sweep would re-park it under the next suffix —
        // a duplicate per interruption. If a note in this folder already holds
        // this backup's content under the recovered stem, the park already
        // landed; just finish the interrupted cleanup. (Content identity, not
        // inode nlink, so it holds on Windows too; mirrors the Swift
        // parkConflictCopyIfAbsent guard.)
        let backup_relative = vault_name(&self.root, &recovered.backup)?;
        let backup_content = String::from_utf8(vault_fs::read(&self.root, &backup_relative)?)
            .map_err(|e| e.to_string())?;
        let already_parked = vault::note_paths(&self.root).into_iter().any(|(id, _)| {
            let (id_folder, id_title) = split_id(&id);
            // Only a note this park could have produced — the exact stem or its
            // numeric collision suffix — counts, NOT a merely similarly-named
            // note like "<stem> draft" that happens to share content (F1).
            id_folder == folder
                && paths::is_unique_variant(&stem, &id_title)
                && self.read(&id).as_deref() == Ok(backup_content.as_str())
        });
        if already_parked {
            // Drop the sidecar ONLY after the backup unlink succeeds. If the
            // unlink fails (Windows lock, dir perms), keep both and propagate so
            // the next bootstrap retries — never leave a sidecar-less, untracked
            // backup no sweep can clean (F2).
            fs::remove_file(&recovered.backup).map_err(io_error)?;
            let _ = fs::remove_file(&recovered.sidecar);
            return Ok(());
        }
        // Park by moving the backup file itself to the recovered name — NO
        // read+create+delete (D1). But NO-REPLACE (E1, same TOCTOU class as A1
        // create / B2 restore): an external writer landing at the chosen
        // recovered name in the allocate→park window must not be clobbered.
        // `move_no_replace` reports Ok(false) rather than overwriting; on a taken
        // name re-suffix and retry. Installing the backup makes it terminal (it is
        // no longer a `.sf-bak-*` the restore loop could resurrect — C1) and
        // consumes the backup to complete the move, then the sidecar goes last so a crash mid-
        // park re-sweeps rather than strands.
        for _ in 0..1000 {
            let id = paths::unique_note_id(&self.root, &wanted, None)?;
            paths::note_path(&self.root, &id)?;
            #[cfg(test)]
            if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
                hook(&id);
            }
            match vault_fs::move_no_replace(&self.root, &backup_relative, &note_filename(&id)) {
                Ok(true) => {
                    let _ = fs::remove_file(&recovered.sidecar);
                    self.search.notify(&FileChange::Changed(note_filename(&id)));
                    return Ok(());
                }
                Ok(false) => continue,
                Err(error) => return Err(error),
            }
        }
        Err("could not allocate a recovered note id after repeated collisions".to_owned())
    }

    /// The id of a DIFFERENT live note sharing `id`'s cross-platform collision
    /// key (case-insensitive + NFC), if any. `create_new_atomic` /
    /// `write_atomic_text` only catch an EXACT-path collision, so on a
    /// case-sensitive filesystem an install at `id` could otherwise shadow a
    /// live note cross-platform. `write_raw` refuses such a write; the flush
    /// verb's recreate and park arms park the draft instead of installing a
    /// shadowing id.
    pub(crate) fn colliding_note(&self, id: &str) -> Option<String> {
        vault::collision_candidates(&self.root, id)
            .into_iter()
            .find(|existing| collides_but_differs(existing, id))
    }

    /// Every overwrite stamps the mtime itself: some filesystems (Samsung f2fs/FUSE)
    /// leave the old time in place after the atomic install's rename. An explicit
    /// time is a sync peer's promise, so failing it is the caller's to see; `now`
    /// is best effort because the bytes have already landed.
    pub(crate) fn stamp_note(&self, id: &str, modified_ms: Option<i64>) -> Result<(), String> {
        let relative = note_filename(id);
        match modified_ms.filter(|value| *value >= 0) {
            Some(explicit) => vault_fs::set_mtime_ms(&self.root, &relative, explicit),
            None => {
                let _ = vault_fs::set_mtime_ms(&self.root, &relative, now_ms());
                Ok(())
            }
        }
    }

    pub(crate) fn write_raw(
        &self,
        id: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<NoteMetadata, String> {
        if let Some(existing) = self.colliding_note(id) {
            return Err(format!(
                "note id collides with existing cross-platform path: {existing}"
            ));
        }
        paths::note_path(&self.root, id)?;
        let change = FileChange::Changed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        vault_fs::write_atomic_local(&self.root, &note_filename(id), content.as_bytes())?;
        self.stamp_note(id, modified_ms)?;
        let metadata = vault::metadata(&self.root, id)
            .ok_or_else(|| "note metadata unavailable after write".to_owned())?;
        self.search.notify(&change);
        Ok(metadata)
    }
}
