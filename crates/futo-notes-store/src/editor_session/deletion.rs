//! Durable deletion decision, separate from fallible recovery-stream retirement.
use super::{recovery_format, storage::VaultRecoveryStorage, EditorLease, RecoveryStorage};
use futo_notes_core::{files::vault_fs, hash::hash_sha256};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::PoisonError;

#[derive(Serialize, Deserialize)]
struct DeleteIntent {
    id: String,
    disk: Option<Vec<u8>>,
    stream: Option<Vec<u8>>,
    committed: bool,
    epoch: u64,
}
fn intent_path(id: &str) -> String {
    format!(".futo-editor-recovery/{}.delete", hash_sha256(id))
}
fn stream_path(id: &str) -> String {
    format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id))
}

fn with_storage<T>(
    root: &Path,
    id: &str,
    action: impl FnOnce(&mut dyn RecoveryStorage) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(state) = EditorLease::attached(root, id)? {
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        action(state.recovery.storage_mut())
    } else {
        action(&mut VaultRecoveryStorage::default())
    }
}

pub(crate) fn prepare(root: &Path, id: &str) -> Result<(), String> {
    recover(root, id)?;
    with_storage(root, id, |storage| {
        let intent = DeleteIntent {
            id: id.to_owned(),
            disk: vault_fs::read_optional(root, &crate::note_filename(id))?,
            stream: storage.read(root, &stream_path(id))?,
            committed: false,
            epoch: futo_notes_core::files::recovery_coordination::replacement_epoch(root, id)?,
        };
        storage.create(root, &intent_path(id), &recovery_format::encode(&intent)?)?;
        storage.flush(root, &intent_path(id))
    })
}

pub(crate) fn commit(root: &Path, id: &str) -> Result<(), String> {
    with_storage(root, id, |storage| {
        let path = intent_path(id);
        let bytes = storage
            .read(root, &path)?
            .ok_or("delete intent disappeared")?;
        let mut intent: DeleteIntent = recovery_format::decode(&bytes, 0)
            .map_err(|error| format!("invalid delete intent: {error:?}"))?;
        intent.committed = true;
        // A separate exclusive decision file never destroys the prepared
        // restore information if decision installation fails.
        let decision = format!("{path}.committed");
        storage.create(root, &decision, &recovery_format::encode(&intent)?)?;
        storage.flush(root, &decision)
    })
}

pub(crate) fn decision_exists(root: &Path, id: &str) -> Result<bool, String> {
    with_storage(root, id, |storage| {
        let Some(bytes) = storage.read(root, &format!("{}.committed", intent_path(id)))? else {
            return Ok(false);
        };
        let intent: DeleteIntent = recovery_format::decode(&bytes, 0)
            .map_err(|error| format!("invalid delete decision: {error:?}"))?;
        if intent.id != id || !intent.committed {
            return Err("delete decision identity mismatch".into());
        }
        Ok(true)
    })
}

pub(crate) fn finish(root: &Path, id: &str) -> Result<(), String> {
    let attachment = EditorLease::attached(root, id)?;
    if let Some(state) = &attachment {
        state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .terminal = true;
    }
    let result = recover(root, id);
    if let Some(state) = &attachment {
        state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .lease
            .release();
    }
    result
}

/// Must run under the store gate and process vault guard before attachment.
/// A prepared interrupted operation rolls back; only a durable decision fences
/// recovery. Committed cleanup never removes a newly created Markdown file.
pub(crate) fn recover(root: &Path, id: &str) -> Result<(), String> {
    let transfer = with_storage(root, id, |storage| recover_inner(root, id, storage))?;
    if let Some((before, after)) = transfer {
        if let Some(state) = EditorLease::attached(root, id)? {
            state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .recovery
                .transfer_own_epoch(before, after)?;
        }
    }
    Ok(())
}

pub(super) fn recover_with_storage(
    root: &Path,
    id: &str,
    storage: &mut dyn RecoveryStorage,
) -> Result<(), String> {
    recover_inner(root, id, storage).map(|_| ())
}

#[derive(Serialize, Deserialize)]
struct Rollback {
    before: u64,
    after: u64,
}
fn recover_inner(
    root: &Path,
    id: &str,
    storage: &mut dyn RecoveryStorage,
) -> Result<Option<(u64, u64)>, String> {
    let path = intent_path(id);
    let decision = format!("{path}.committed");
    let committed = storage.read(root, &decision)?;
    let prepared = storage.read(root, &path)?;
    let Some(bytes) = committed.as_ref().or(prepared.as_ref()) else {
        return Ok(None);
    };
    let intent: DeleteIntent = recovery_format::decode(bytes, 0)
        .map_err(|error| format!("invalid delete intent: {error:?}"))?;
    if intent.id != id || intent.committed != committed.is_some() {
        return Err("delete intent identity mismatch".into());
    }
    let stream = stream_path(id);
    let mut transfer = None;
    if intent.committed {
        if storage.read(root, &stream)? == intent.stream {
            storage.remove(root, &stream)?;
        }
    } else if let Some(disk) = &intent.disk {
        let note = crate::note_filename(id);
        if vault_fs::read_optional(root, &note)?.is_some_and(|current| current != *disk) {
            return Err(
                "delete rollback source was replaced; original bytes retained in intent".into(),
            );
        }
        let rollback_path = format!("{path}.rollback");
        let rollback = if let Some(bytes) = storage.read(root, &rollback_path)? {
            Some(
                recovery_format::decode::<Rollback>(&bytes, 0)
                    .map_err(|error| format!("invalid rollback observation: {error:?}"))?,
            )
        } else if vault_fs::read_optional(root, &note)?.is_none() {
            let before =
                futo_notes_core::files::recovery_coordination::replacement_epoch(root, id)?;
            let observation = Rollback {
                before,
                after: before.checked_add(1).ok_or("replacement epoch exhausted")?,
            };
            storage.create(
                root,
                &rollback_path,
                &recovery_format::encode(&observation)?,
            )?;
            storage.flush(root, &rollback_path)?;
            Some(observation)
        } else {
            None
        };
        if vault_fs::read_optional(root, &note)?.is_none()
            && vault_fs::create_new(root, &note, disk)?
        {
            vault_fs::sync_file(root, &note)?;
            vault_fs::sync_parent(root, &note)?;
        }
        if vault_fs::read_optional(root, &note)?.as_deref() != Some(disk.as_slice()) {
            return Err("delete rollback destination changed; original intent retained".into());
        }
        if let Some(observation) = rollback {
            let actual =
                futo_notes_core::files::recovery_coordination::replacement_epoch(root, id)?;
            if observation.before == intent.epoch && actual == observation.after {
                if let Some(bytes) = storage.read(root, &stream)? {
                    let first = bytes
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .ok_or("incomplete recovery header during rollback")?
                        + 1;
                    let mut header =
                        recovery_format::decode_header(&bytes[..first]).map_err(|error| {
                            format!("invalid recovery header during rollback: {error:?}")
                        })?;
                    if header.id == id
                        && header.version == recovery_format::VERSION
                        && header.vault
                            == root
                                .canonicalize()
                                .map_err(|error| error.to_string())?
                                .to_string_lossy()
                        && header.replacement_epoch == observation.before
                    {
                        header.replacement_epoch = observation.after;
                        let mut replacement = recovery_format::encode(&header)?;
                        replacement.extend_from_slice(&bytes[first..]);
                        storage.replace(root, &stream, &replacement)?;
                        storage.flush(root, &stream)?;
                    }
                }
                transfer = Some((observation.before, observation.after));
            }
        }
    }
    // Decision removal comes last: an interrupted cleanup repeats safely.
    storage.remove(root, &path)?;
    storage.remove(root, &decision)?;
    storage.remove(root, &format!("{path}.rollback"))?;
    Ok(transfer)
}
