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
    with_storage(root, id, |storage| {
        let path = intent_path(id);
        let decision = format!("{path}.committed");
        let committed = storage.read(root, &decision)?;
        let prepared = storage.read(root, &path)?;
        let Some(bytes) = committed.as_ref().or(prepared.as_ref()) else {
            return Ok(());
        };
        let intent: DeleteIntent = recovery_format::decode(bytes, 0)
            .map_err(|error| format!("invalid delete intent: {error:?}"))?;
        if intent.id != id || intent.committed != committed.is_some() {
            return Err("delete intent identity mismatch".into());
        }
        let stream = stream_path(id);
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
            if vault_fs::create_new(root, &note, disk)? {
                vault_fs::sync_file(root, &note)?;
                vault_fs::sync_parent(root, &note)?;
            }
        }
        // Decision removal comes last: an interrupted cleanup repeats safely.
        storage.remove(root, &path)?;
        storage.remove(root, &decision)
    })
}
