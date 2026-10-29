//! Attachment coordination underneath all supported note and folder mappings.
use super::{Attachment, EditorLease, RecoveryLog, RecoveryOptions};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

pub(crate) struct IdentityTransition {
    state: Arc<Mutex<Attachment>>,
    pending: PendingIdentity,
}
pub(super) struct PendingIdentity {
    original: String,
    destination: String,
    lease: Option<EditorLease>,
}
impl Attachment {
    pub(super) fn finish_identity(&mut self, root: &Path) -> Result<(), String> {
        if self.pending_identity.is_none() {
            return Ok(());
        }
        let pending = self.pending_identity.as_mut().unwrap();
        if pending.lease.is_none()
            && futo_notes_core::files::collision_key(&pending.original)
                != futo_notes_core::files::collision_key(&pending.destination)
        {
            if !self
                .recovery
                .identity_destination_ready(root, &pending.original)?
            {
                return Err(
                    "identity destination has another recovery stream; both retained".into(),
                );
            }
            pending.lease = Some(
                EditorLease::acquire(root, &pending.destination)
                    .map_err(|error| error.to_string())?,
            );
        }
        self.recovery
            .complete_identity(root, &self.pending_identity.as_ref().unwrap().original)?;
        let pending = self.pending_identity.take().unwrap();
        if let Some(lease) = pending.lease {
            self.lease = lease;
        }
        self.id = pending.destination;
        Ok(())
    }
}
impl IdentityTransition {
    /// Caller owns its store gate and the process vault guard. Registry lookup
    /// releases its mutex before this operation locks any attachment.
    pub(crate) fn prepare(
        root: &Path,
        from: &str,
        to: &str,
        rewritten: Option<&String>,
    ) -> Result<Option<Self>, String> {
        let state = if let Some(state) = EditorLease::attached(root, from)? {
            state
        } else {
            let source_stream = format!(
                ".futo-editor-recovery/{}.jsonl",
                futo_notes_core::hash::hash_sha256(from)
            );
            if futo_notes_core::files::vault_fs::read_optional(root, &source_stream)?.is_none() {
                return Ok(None);
            }
            let options = RecoveryOptions::default();
            let lease = EditorLease::acquire(root, from).map_err(|error| error.to_string())?;
            let disk = futo_notes_core::files::vault_fs::read(root, &crate::note_filename(from))?;
            let disk = std::str::from_utf8(&disk).map_err(|error| error.to_string())?;
            let (recovery, engine) =
                RecoveryLog::open(root, from, disk, options.clock, options.storage)?;
            let state = Arc::new(Mutex::new(Attachment {
                id: from.to_owned(),
                engine,
                recovery,
                lease,
                pending_checkpoint: None,
                terminal: false,
                pending_identity: None,
            }));
            state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .lease
                .bind(&state);
            state
        };
        let mut attachment = state.lock().unwrap_or_else(PoisonError::into_inner);
        if attachment.terminal {
            return Err("editor attachment was deleted".into());
        }
        if attachment.pending_checkpoint.is_some()
            || attachment.pending_identity.is_some()
            || attachment.recovery.failed
        {
            return Err("editor recovery must settle before changing identity".into());
        }
        let lease = if futo_notes_core::files::collision_key(from)
            == futo_notes_core::files::collision_key(to)
        {
            None
        } else {
            if futo_notes_core::files::recovery_coordination::has_pending_recovery(root, to)? {
                if EditorLease::attached(root, to)?.is_some() {
                    return Err("rename destination has an active editor".into());
                }
                None
            } else {
                Some(EditorLease::acquire(root, to).map_err(|error| error.to_string())?)
            }
        };
        let disk = futo_notes_core::files::vault_fs::read(root, &crate::note_filename(from))?;
        let mut expected = vec![String::from_utf8(disk).map_err(|error| error.to_string())?];
        expected.extend(rewritten.cloned());
        attachment.recovery.prepare_identity(root, to, expected)?;
        drop(attachment);
        Ok(Some(Self {
            state,
            pending: PendingIdentity {
                original: from.to_owned(),
                destination: to.to_owned(),
                lease,
            },
        }))
    }
    pub(crate) fn finish(self, root: &Path) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.pending_identity = Some(self.pending);
        let result = state.finish_identity(root);
        state.lease.bind(&self.state);
        result
    }
}
