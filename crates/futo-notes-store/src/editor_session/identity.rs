//! Attachment coordination underneath all supported note and folder mappings.
use super::{Attachment, EditorLease};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

pub(crate) struct IdentityTransition {
    state: Arc<Mutex<Attachment>>,
    destination: String,
    lease: Option<EditorLease>,
}

impl IdentityTransition {
    /// Caller owns its store gate and the process vault guard. Registry lookup
    /// releases its mutex before this operation locks any attachment.
    pub(crate) fn prepare(root: &Path, from: &str, to: &str) -> Result<Option<Self>, String> {
        let Some(state) = EditorLease::attached(root, from)? else {
            return Ok(None);
        };
        let attachment = state.lock().unwrap_or_else(PoisonError::into_inner);
        if attachment.terminal {
            return Err("editor attachment was deleted".into());
        }
        if attachment.pending_checkpoint.is_some() || attachment.recovery.failed {
            return Err("editor recovery must settle before changing identity".into());
        }
        let lease = if futo_notes_core::files::collision_key(from)
            == futo_notes_core::files::collision_key(to)
        {
            None
        } else {
            if futo_notes_core::files::recovery_coordination::has_pending_recovery(root, to)? {
                return Err("rename destination has pending editor recovery".into());
            }
            Some(EditorLease::acquire(root, to).map_err(|error| error.to_string())?)
        };
        drop(attachment);
        Ok(Some(Self {
            state,
            destination: to.to_owned(),
            lease,
        }))
    }

    pub(crate) fn finish(mut self, root: &Path) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.recovery.retarget_identity(root, &self.destination)?;
        if let Some(lease) = self.lease.take() {
            lease.bind(&self.state);
            state.lease = lease;
        }
        state.id = self.destination;
        Ok(())
    }
}
