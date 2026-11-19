//! An attached note's id changing under it (rename, move, backlink rewrite, a
//! sync relocation, a rename the file watcher saw). Everything here is in
//! memory but adopting an own recreation: the draft stays, only the identity
//! and the baseline move, and the attachment's host hears it.
use super::{Attachment, EditorLease};
use crate::{note_filename, paths, FileChange, LocalNoteStore};
use futo_notes_core::files::{
    collision_key, note_id_from_filename, vault_fs, vault_mutation_guard,
};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

impl Attachment {
    /// `lease` is the destination's, taken first: None when one lease covers
    /// both names (a case-only move).
    fn moved_to(&mut self, id: String, lease: Option<EditorLease>, state: &Arc<Mutex<Attachment>>) {
        if let Some(lease) = lease {
            self.lease = lease;
        }
        self.id = id;
        self.recreated_over = None;
        self.lease.bind(state);
        if let Some(moved) = &self.moved {
            moved();
        }
    }
}

/// The store's [`futo_notes_core::files::note_moved`] observer: a vault
/// mutation outside the store (a sync relocation) moved the file `from` to `to`
/// and still holds the vault guard. An attachment on `from` follows to `to`
/// with its draft and baseline, so its next save writes the note where it now
/// is, or parks against bytes that changed — never recreates `from`.
pub(crate) fn follow_moved(root: &Path, from: &str, to: &str) {
    let (Some(from), Some(to)) = (note_id_from_filename(from), note_id_from_filename(to)) else {
        return;
    };
    let Ok(Some(state)) = EditorLease::attached(root, &from) else {
        return;
    };
    let mut attachment = state.lock().unwrap_or_else(PoisonError::into_inner);
    if attachment.terminal {
        return;
    }
    if let Some(lease) = destination_lease(root, &from, &to) {
        attachment.moved_to(to, lease, &state);
    }
}

/// A rename made outside the store, which the file watcher saw
/// (`LocalNoteStore::observe_external_change`). An attachment on `from`
/// follows to `to` once `from`'s file is gone; `to` need not exist, so a chain
/// of renames follows one event at a time. `from` back on disk because this
/// attachment's own save recreated it before the rename reached the store is
/// adopted: when `from` holds what the attachment last wrote there (no one else
/// wrote it since) and `to` holds exactly what `from` held before the
/// recreation, `from` is removed and that baseline returns, so the next save
/// fast-forwards the renamed file. Anything else changes nothing: a `to` that
/// is missing (a deletion undone, a replayed event) never costs the recreation.
pub(crate) fn follow_external_rename(
    store: &LocalNoteStore,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let (Some(from), Some(to)) = (note_id_from_filename(from), note_id_from_filename(to)) else {
        return Ok(());
    };
    let _gate = store.lock_gate()?;
    let _vault = vault_mutation_guard()?;
    follow_external_rename_locked(store, &from, &to)
}

/// [`follow_external_rename`] by note ids, for a caller that holds the store
/// gate and the vault guard.
pub(crate) fn follow_external_rename_locked(
    store: &LocalNoteStore,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let (from, to) = (from.to_owned(), to.to_owned());
    let root = &store.root;
    paths::note_path(root, &from)?;
    paths::note_path(root, &to)?;
    let Some(state) = EditorLease::attached(root, &from)? else {
        return Ok(());
    };
    let mut attachment = state.lock().unwrap_or_else(PoisonError::into_inner);
    if attachment.terminal || attachment.id != from {
        return Ok(());
    }
    let from_file = note_filename(&from);
    // A case-only rename is one file, which a case-insensitive disk still finds.
    let from_remains =
        collision_key(&from) != collision_key(&to) && vault_fs::exists(root, &from_file)?;
    let adopted = match (from_remains, attachment.recreated_over.clone()) {
        (false, _) => None,
        (true, Some(before))
            if String::from_utf8(vault_fs::read(root, &from_file)?)
                .is_ok_and(|disk| disk == attachment.base)
                && vault_fs::read_optional(root, &note_filename(&to))?
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .is_some_and(|renamed| renamed == before) =>
        {
            Some(before)
        }
        (true, _) => return Ok(()),
    };
    // Taken before anything changes: refused, nothing has.
    let Some(lease) = destination_lease(root, &from, &to) else {
        return Ok(());
    };
    if adopted.is_some() {
        // Removed before the attachment moves: a remove that fails changes
        // nothing (dropping `lease` releases `to`). Registered first, like every
        // store delete: the watcher must not report this unlink as the open
        // note deleted outside the app.
        let removed = FileChange::Removed(from_file.clone());
        store
            .before_write
            .before_write(std::slice::from_ref(&removed));
        vault_fs::remove(root, &from_file)?;
        // Like every store delete: a pending rename that ended at `from` is over.
        if let Err(error) = crate::rename_journal::forget_deleted_locked(root, &from_file) {
            futo_notes_core::log_to_stderr!(
                "the rename journal kept its intent for {from:?}: {error}"
            );
        }
        crate::relink::prune_empty_parents(root, &paths::note_path(root, &from)?);
        store.search.notify(&removed);
    }
    attachment.moved_to(to, lease, &state);
    if let Some(before) = adopted {
        attachment.set_base(before);
        attachment.note_edit();
    }
    Ok(())
}

/// `to`'s lease for an attachment leaving `from` (the caller holds the vault
/// guard): `Some(None)` when one lease covers both, a case-only move. None
/// when another session holds `to` (only a phone can attach two notes): the
/// attachment stays, and its next save recreates `from`.
fn destination_lease(root: &Path, from: &str, to: &str) -> Option<Option<EditorLease>> {
    if collision_key(from) == collision_key(to) {
        return Some(None);
    }
    match EditorLease::acquire(root, to) {
        Ok(lease) => Some(Some(lease)),
        Err(error) => {
            futo_notes_core::log_to_stderr!(
                "editor attachment could not follow {from:?} to {to:?}: {error}"
            );
            None
        }
    }
}

/// Prepared under the store gate before files move; `finish` after they did.
/// Dropping it unfinished releases the destination lease.
pub(crate) struct IdentityTransition {
    state: Arc<Mutex<Attachment>>,
    destination: String,
    lease: Option<EditorLease>,
    /// The store's rewritten bytes for this note, when the relink changed it.
    rewritten: Option<String>,
    /// What the file held before the action.
    before: String,
}

impl IdentityTransition {
    /// Caller owns its store gate and the process vault guard. Registry lookup
    /// releases its mutex before this operation locks the attachment.
    pub(crate) fn prepare(
        root: &Path,
        from: &str,
        to: &str,
        rewritten: Option<&String>,
    ) -> Result<Option<Self>, String> {
        let Some(state) = EditorLease::attached(root, from)? else {
            return Ok(None);
        };
        let attachment = state.lock().unwrap_or_else(PoisonError::into_inner);
        if attachment.terminal {
            return Err("editor attachment was deleted".into());
        }
        drop(attachment);
        // A destination attached by another session refuses the action.
        let lease = if collision_key(from) == collision_key(to) {
            None
        } else {
            let lease = EditorLease::acquire(root, to).map_err(|error| match error {
                super::EditorStoreError::SessionAlreadyOpen => {
                    "rename destination has an active editor".to_owned()
                }
                other => other.to_string(),
            })?;
            lease.bind(&state);
            Some(lease)
        };
        let before = futo_notes_core::files::vault_fs::read(root, &crate::note_filename(from))?;
        Ok(Some(Self {
            state,
            destination: to.to_owned(),
            lease,
            rewritten: rewritten.cloned(),
            before: String::from_utf8(before).map_err(|error| error.to_string())?,
        }))
    }

    pub(crate) fn finish(mut self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let lease = self.lease.take();
        state.moved_to(std::mem::take(&mut self.destination), lease, &self.state);
        let Some(rewritten) = self.rewritten.take() else {
            return;
        };
        if state.engine.source_text() == self.before {
            let revision = state.engine.revision();
            if state.portable {
                // The page adopts the rewrite itself, as one Undo step.
                if rewritten != self.before {
                    state.relink_offer = Some(futo_notes_editor::RelinkOffer {
                        revision,
                        source: rewritten.clone(),
                    });
                }
            } else if state.engine.composition().is_none() {
                if let Ok(Some(change)) =
                    state
                        .engine
                        .apply_own_relink(revision, &rewritten, &mut |_| Ok(()))
                {
                    state.coordinated.push(change);
                }
            }
            if state.relink_offer.is_some() || state.engine.source_text() == rewritten {
                state.mark_saved();
            }
        }
        // A draft that differs from the file stays verbatim; either way the
        // file now holds the rewritten bytes.
        state.set_base(rewritten);
    }
}
