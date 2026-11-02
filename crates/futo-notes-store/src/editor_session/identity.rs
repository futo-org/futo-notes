//! An attached note's id changing under it (rename, move, backlink rewrite).
//! Everything here is in memory: the draft stays, only the identity and the
//! baseline move.
use super::{Attachment, EditorLease};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

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
        let lease = if futo_notes_core::files::collision_key(from)
            == futo_notes_core::files::collision_key(to)
        {
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
        if let Some(lease) = self.lease.take() {
            state.lease = lease;
        }
        state.id = std::mem::take(&mut self.destination);
        state.lease.bind(&self.state);
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
        state.base = rewritten;
    }
}
