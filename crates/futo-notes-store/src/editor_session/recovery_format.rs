//! Checksummed recovery framing. Newlines commit a frame; an incomplete final
//! frame is distinct from invalid bytes inside the committed prefix.
use futo_notes_core::hash::hash_sha256;
use futo_notes_editor::{Revision, SourceEdit};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::{RecoveryIssue, RecoveryIssueKind};

pub(super) const VERSION: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Header {
    pub version: u32,
    pub vault: String,
    pub id: String,
    pub base: String,
    pub base_revision: Revision,
    #[serde(default)]
    pub replacement_epoch: u64,
}

#[derive(Serialize, Deserialize)]
pub(super) enum Record {
    Edit(SourceEdit),
    Checkpoint { id: String, revision: Revision },
}

#[derive(Serialize, Deserialize)]
struct Frame {
    payload: String,
    sha256: String,
}

pub(super) fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let mut bytes = serde_json::to_vec(&Frame {
        sha256: hash_sha256(&payload),
        payload,
    })
    .map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub(super) fn decode<T: DeserializeOwned>(bytes: &[u8], record: usize) -> Result<T, RecoveryIssue> {
    let invalid = || RecoveryIssue {
        kind: RecoveryIssueKind::CorruptRecord,
        record,
    };
    let frame: Frame = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if frame.sha256 != hash_sha256(&frame.payload) {
        return Err(invalid());
    }
    serde_json::from_str(&frame.payload).map_err(|_| invalid())
}

// Version 1 predates checksummed frames. Never replay it, but distinguish a
// recognized incompatible format from random corrupt bytes for recovery UI.
pub(super) fn decode_header(bytes: &[u8]) -> Result<Header, RecoveryIssue> {
    decode(bytes, 0).map_err(|error| match serde_json::from_slice::<Header>(bytes) {
        Ok(header) if header.version != VERSION => RecoveryIssue {
            kind: RecoveryIssueKind::UnsupportedVersion {
                version: header.version,
            },
            record: 0,
        },
        _ => error,
    })
}
