use futo_notes_core::e2ee;
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::ObjectState;
use crate::server::{timestamp_ms, Http, Object, Write};

use super::{FailureKind, SyncErrorKind, SyncFailure};

pub(super) fn encrypt(key: &[u8; 32], name: &str, content: &str) -> Result<Vec<u8>, SyncErrorKind> {
    e2ee::aes_gcm_encrypt(key, &e2ee::pack_note_v2(name, content))
        .map_err(|error| SyncErrorKind::Crypto(error.to_string()))
}

pub(super) async fn decrypt(
    http: &Http,
    key: &[u8; 32],
    object: &Object,
) -> Result<RemoteNote, SyncFailure> {
    let blob_key = object.blob_key.as_deref().ok_or_else(|| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Download,
        status_code: None,
    })?;
    let ciphertext = http.blob(blob_key).await.map_err(|error| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Download,
        status_code: error.status,
    })?;
    let plaintext = e2ee::aes_gcm_decrypt(key, &ciphertext).map_err(|_| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Decrypt,
        status_code: None,
    })?;
    let note = e2ee::unpack_note(&plaintext).map_err(|_| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Decrypt,
        status_code: None,
    })?;
    Ok(RemoteNote {
        object: object.clone(),
        name: note.path,
        content: note.content,
    })
}

#[derive(Clone)]
pub(super) struct RemoteNote {
    pub(super) object: Object,
    pub(super) name: String,
    pub(super) content: String,
}

pub(super) fn object_state(write: &Write, hash: String, size: u64) -> ObjectState {
    ObjectState {
        object_id: write.object.id.clone(),
        version: write.object.version,
        blob_key: write.object.blob_key.clone().unwrap_or_default(),
        hash: Some(hash),
        mtime_ms: Some(timestamp_ms(&write.object.updated_at)),
        size_bytes: Some(size),
    }
}

pub(super) fn state_from_remote(remote: &RemoteNote) -> ObjectState {
    ObjectState {
        object_id: remote.object.id.clone(),
        version: remote.object.version,
        blob_key: remote.object.blob_key.clone().unwrap_or_default(),
        hash: Some(hash_sha256(&remote.content)),
        mtime_ms: Some(timestamp_ms(&remote.object.updated_at)),
        size_bytes: Some(remote.content.len() as u64),
    }
}
