//! Attachment coordination underneath all supported note and folder mappings.
use super::{Attachment, EditorLease, RecoveryLog, RecoveryOptions};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

pub(crate) struct IdentityTransition {
    state: Arc<Mutex<Attachment>>,
    pending: Option<PendingIdentity>,
    root: std::path::PathBuf,
}
impl Drop for IdentityTransition {
    fn drop(&mut self) {
        if self.pending.is_some() {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.recovery.cancel_prepared_identity(&self.root).is_err() {
                state.recovery.failed = true;
            }
        }
    }
}
pub(super) struct PendingIdentity {
    original: String,
    destination: String,
    lease: Option<EditorLease>,
    /// The store's rewritten note bytes, when the relink changed this note.
    rewritten: Option<String>,
    installed: bool,
    portable_offer: Option<(futo_notes_editor::Revision, String)>,
}
impl PendingIdentity {
    pub(super) fn targets(&self, id: &str) -> bool {
        futo_notes_core::files::collision_key(&self.destination)
            == futo_notes_core::files::collision_key(id)
    }
    pub(super) fn release(&mut self) {
        if let Some(lease) = &mut self.lease {
            lease.release();
        }
    }
}
impl Attachment {
    pub(super) fn finish_identity(&mut self, root: &Path) -> Result<(), String> {
        if self.pending_identity.is_none() {
            return Ok(());
        }
        self.materializing_reset(root)?;
        let pending = self.pending_identity.as_mut().unwrap();
        if !pending.installed
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
            if pending.lease.is_none() {
                pending.lease = Some(
                    EditorLease::acquire(root, &pending.destination)
                        .map_err(|error| error.to_string())?,
                );
            }
        }
        let pending = self.pending_identity.as_mut().unwrap();
        if !pending.installed {
            self.recovery.install_identity(root, &pending.original)?;
            pending.installed = true;
        }
        if self.engine.revision() != self.recovery.accepted {
            let rewritten = pending
                .rewritten
                .as_deref()
                .ok_or("coordinated relink has no rewritten source")?;
            let accepted = self.recovery.accepted;
            let revision = self.engine.revision();
            let change = self
                .engine
                .full_mut()
                .map_err(|error| error.to_string())?
                .apply_own_relink(revision, rewritten, &mut |edit| {
                    if edit.revision == accepted {
                        Ok(())
                    } else {
                        Err("coordinated source revision mismatch".into())
                    }
                })
                .map_err(|error| error.to_string())?
                .ok_or("coordinated relink produced no source change")?;
            if self.engine.source_text() != self.recovery.snapshot_source() {
                return Err("coordinated source differs from protected snapshot".into());
            }
            self.coordinated.push(change);
        }
        self.recovery.cleanup_identity(root, &pending.original)?;
        let pending = self.pending_identity.take().unwrap();
        self.relink_offer = pending.portable_offer.and_then(|(revision, rewritten)| {
            (self.recovery.base() == rewritten).then_some(futo_notes_editor::RelinkOffer {
                revision,
                source: rewritten,
            })
        });
        if let Some(lease) = pending.lease {
            self.lease = lease;
        }
        self.id = pending.destination;
        Ok(())
    }
}
impl IdentityTransition {
    /// The baseline-aware workflow owns checkpoint and identity together. It
    /// may follow a parked snapshot without ever renaming the peer source.
    pub(crate) fn save_draft(
        store: &crate::LocalNoteStore,
        id: &str,
        wanted: &str,
        base: &str,
        content: &str,
    ) -> Result<Option<crate::MutationResult>, String> {
        let Some(state) = EditorLease::attached(&store.root, id)? else {
            return Ok(None);
        };
        let mut attachment = state.lock().unwrap_or_else(PoisonError::into_inner);
        if attachment.terminal {
            return Err("editor attachment was deleted".into());
        }
        attachment.materializing_reset(&store.root)?;
        if attachment.engine.source_text() != content {
            return Ok(None);
        }
        let result = attachment
            .checkpoint_draft(store, Some((base, wanted)))
            .map_err(|error| error.to_string())?;
        attachment.lease.bind(&state);
        if let crate::FlushDisposition::ParkedConflict { parked_id } = &result.disposition {
            let metadata = crate::vault::metadata(&store.root, parked_id)
                .ok_or("parked draft metadata unavailable")?;
            return Ok(Some(
                result
                    .mutation
                    .unwrap_or_else(|| store.upsert_mutation(metadata)),
            ));
        }
        let current = attachment.id.clone();
        drop(attachment);
        store.rename_raw(&current, wanted).map(Some)
    }

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
            // A detached backlink draft did not participate in this action.
            // Its unchanged identity remains protected by replacement epochs,
            // just like any intentional outside write. Only an actual move
            // needs to carry a detached stream to a different identity.
            if from == to {
                return Ok(None);
            }
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
                engine: super::EditorOwner(Some(super::EditorMode::Full(engine))),
                recovery,
                lease,
                pending_checkpoint: None,
                terminal: false,
                coordinated: Vec::new(),
                pending_identity: None,
                portable: false,
                bounded_work: futo_notes_editor::BoundedWork::default(),
                relink_offer: None,
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
        attachment.materializing_reset(root)?;
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
        if let Some(lease) = &lease {
            lease.bind(&state);
        }
        let disk = futo_notes_core::files::vault_fs::read(root, &crate::note_filename(from))?;
        let mut expected = vec![String::from_utf8(disk).map_err(|error| error.to_string())?];
        expected.extend(rewritten.cloned());
        let portable_offer =
            if attachment.portable && attachment.engine.source_text() == expected[0] {
                rewritten
                    .filter(|rewritten| **rewritten != expected[0])
                    .map(|rewritten| (attachment.engine.revision(), rewritten.clone()))
            } else {
                None
            };
        let can_adopt = !attachment.portable
            && attachment
                .engine
                .full()
                .map_err(|error| error.to_string())?
                .composition()
                .is_none();
        if let Err(error) = attachment
            .recovery
            .prepare_identity(root, to, expected, can_adopt)
        {
            if attachment.recovery.cancel_prepared_identity(root).is_err() {
                attachment.recovery.failed = true;
            }
            return Err(error);
        }
        drop(attachment);
        Ok(Some(Self {
            state,
            root: root.to_owned(),
            pending: Some(PendingIdentity {
                original: from.to_owned(),
                destination: to.to_owned(),
                lease,
                rewritten: rewritten.cloned(),
                installed: false,
                portable_offer,
            }),
        }))
    }
    pub(crate) fn finish(mut self, root: &Path) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.pending_identity = self.pending.take();
        let result = state.finish_identity(root);
        state.lease.bind(&self.state);
        result
    }
}
