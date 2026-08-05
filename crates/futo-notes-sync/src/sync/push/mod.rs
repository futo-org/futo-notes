use std::path::Path;

use crate::checkpoint::{self, ConnectedState};
use crate::server::Http;
use crate::session::connect::client;

use super::outcome::{append_derived_renames, record_checkpoint_failure};
use super::tombstones::recover_stale_claims;
use super::vault::local_files;
use super::{
    CycleFailure, PreWrite, Progress, SaveCheckpoint, SyncErrorKind, SyncProgress, SyncSummary,
};

mod delete_local;
pub(in crate::sync) mod local_changes;
#[cfg(test)]
mod tests;

use super::transfer::upload_executor::{recover_pending_creates, upload_local_files, UploadFiles};
use delete_local::delete_missing_objects;
use local_changes::{detect_local_renames, missing_local_files};

pub(in crate::sync) mod reason {
    pub(in crate::sync) const NOT_ON_SERVER: &str = "not_on_server";
    pub(in crate::sync) const REMOTE_OBJECT_DELETED: &str = "remote_object_was_deleted";
    pub(in crate::sync) const LOCAL_CONTENT_CHANGED: &str = "local_content_changed";
    pub(in crate::sync) const SERVER_REJECTED_413: &str = "server_rejected_413";
    pub(in crate::sync) const UNCHANGED_SINCE_413: &str = "unchanged_since_413";
    pub(in crate::sync) const LOCAL_FILE_GONE: &str = "local_file_gone";
    pub(in crate::sync) const SAME_HASH_AND_BASENAME: &str = "same_hash_and_basename";
    pub(in crate::sync) const DELETE_LOST_TO_REMOTE_EDIT: &str = "delete_lost_to_remote_edit";
    pub(in crate::sync) const ENCRYPT_ERROR: &str = "encrypt_error";
    pub(in crate::sync) const READ_ERROR: &str = "read_error";
    pub(in crate::sync) const UPLOAD_ERROR: &str = "upload_error";
    pub(in crate::sync) const DELETE_ERROR: &str = "delete_error";
}

pub(in crate::sync) fn status_detail(status: Option<u16>) -> String {
    status.map_or_else(|| "no status".to_owned(), |status| format!("HTTP {status}"))
}

pub(super) struct PushContext<'a> {
    pub(super) http: &'a Http,
    pub(super) state: &'a mut ConnectedState,
    pub(super) root: &'a Path,
    pub(super) summary: &'a mut SyncSummary,
    pub(super) pre_write: &'a PreWrite,
    pub(super) save_checkpoint: &'a SaveCheckpoint,
}

pub(crate) async fn push(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    push_with_checkpoint(state, root, progress, pre_write, &checkpoint::save)
        .await
        .map_err(|failure| failure.kind)
}

pub(crate) async fn push_with_checkpoint(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
) -> Result<(SyncSummary, ConnectedState), CycleFailure> {
    recover_stale_claims(root, pre_write);
    let mut files = local_files(root).map_err(|error| CycleFailure {
        kind: SyncErrorKind::Io(error),
        state: state.clone(),
    })?;
    let http = client(state).map_err(|kind| CycleFailure {
        kind,
        state: state.clone(),
    })?;
    let mut next = state.clone();
    let mut summary = SyncSummary::default();
    let blocked_pending = recover_pending_creates(&http, &mut next, root, &files, &mut summary)
        .await
        .map_err(|kind| CycleFailure {
            kind,
            state: next.clone(),
        })?;
    let missing = missing_local_files(&next, &files);
    let (claimed_missing, renamed_files) =
        detect_local_renames(&mut next, root, &files, &missing, &mut summary).map_err(|error| {
            CycleFailure {
                kind: SyncErrorKind::Io(error),
                state: next.clone(),
            }
        })?;
    files.sort_by_key(|file| file.size);

    progress(SyncProgress {
        phase: "pushing",
        current: 0,
        total: files.len() + missing.len(),
    });
    upload_local_files(UploadFiles {
        context: PushContext {
            http: &http,
            state: &mut next,
            root,
            summary: &mut summary,
            pre_write,
            save_checkpoint,
        },
        files: &files,
        blocked_pending: &blocked_pending,
        renamed_files: &renamed_files,
        progress,
        progress_total: files.len() + missing.len(),
    })
    .await
    .map_err(|kind| CycleFailure {
        kind,
        state: next.clone(),
    })?;
    if let Err(kind) = delete_missing_objects(
        PushContext {
            http: &http,
            state: &mut next,
            root,
            summary: &mut summary,
            pre_write,
            save_checkpoint,
        },
        missing,
        &claimed_missing,
    )
    .await
    {
        return Err(CycleFailure { kind, state: next });
    }
    append_derived_renames(&mut summary, &state.object_map, &next.object_map);
    if save_checkpoint(root, &next).is_err() {
        record_checkpoint_failure(&mut summary);
    }
    Ok((summary, next))
}
