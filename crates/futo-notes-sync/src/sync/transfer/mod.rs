use crate::checkpoint::{ObjectState, PendingCreate};
use crate::server::{Conflict, Object, Write};

use super::encrypted_note::RemoteNote;
use super::vault::LocalFile;
use super::SyncFailure;

pub(super) mod download_executor;
pub(super) mod http_transport;
pub(super) mod upload_executor;

#[derive(Clone)]
pub(super) enum UploadTarget {
    Create(PendingCreate),
    Update(ObjectState),
}

#[derive(Clone)]
pub(super) struct UploadCandidate {
    pub(super) file: LocalFile,
    pub(super) target: UploadTarget,
    pub(super) content: String,
    pub(super) hash: String,
    pub(super) ciphertext: Vec<u8>,
    pub(super) local_was_rename: bool,
}

pub(super) enum CandidateResult {
    Created(Write),
    Replayed(Write),
    Updated(Write),
    Conflict(Conflict),
    TooLarge,
    Failed(Option<u16>),
}

pub(super) type CompletedUpload = (UploadCandidate, CandidateResult);
pub(super) type DownloadedObject = (Object, Result<RemoteNote, SyncFailure>);
