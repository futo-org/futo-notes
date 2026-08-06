mod clean_merge;
mod conflict_copy;
mod guarded_adoption;
mod remote_revision;

#[cfg(test)]
mod test_support;

use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};

use crate::checkpoint::ObjectState;
use crate::server::Conflict;

use self::clean_merge::{persist_clean_merge, MergeAttempt};
use self::conflict_copy::write_conflict_pair;
use self::guarded_adoption::adopt_matching_remote;
use self::remote_revision::{fetch_current_object, merge_remote_content};
use super::encrypted_note::decrypt;
use super::push::PushContext;
use super::transfer::upload_executor::{create_fresh, Upload};
use super::vault::LocalFile;
use super::{SyncErrorKind, SyncFailure};

pub(super) mod reason {
    pub(super) const REMOTE_ALREADY_HOLDS_LOCAL: &str = "remote_already_holds_local_content";
    pub(super) const THREE_WAY_MERGE_WAS_CLEAN: &str = "three_way_merge_was_clean";
    pub(super) const MERGE_IMPOSSIBLE: &str = "concurrent_edit_could_not_merge";
    pub(super) const SERVER_REJECTED_413: &str = "server_rejected_413";
    pub(super) const REMOTE_OBJECT_DELETED: &str = "remote_object_was_deleted";
    pub(super) const CONFLICT_COPY_UPLOAD: &str = "conflict_copy_upload";
    pub(super) const REMOTE_HAS_NO_BLOB: &str = "remote_object_has_no_blob";
}

pub(super) type ConflictResolution = Option<(String, ObjectState)>;

struct LiveRemoteConflict<'a> {
    file: &'a LocalFile,
    existing: &'a ObjectState,
    local: &'a str,
    local_hash: String,
    response: Conflict,
    local_was_rename: bool,
    current: crate::server::Object,
}

pub(super) async fn create_from_content(
    context: &mut PushContext<'_>,
    name: &str,
    content: &str,
    hash: String,
    size: u64,
    mtime: i64,
    reason: &'static str,
) -> Result<ConflictResolution, SyncErrorKind> {
    create_fresh(
        context,
        Upload {
            name,
            content,
            hash,
            size,
            mtime,
            reason,
        },
    )
    .await
    .map(|state| state.map(|state| (name.to_owned(), state)))
}

fn resolved_remote_name(remote_name: &str, local_name: &str) -> String {
    match classify_incoming_sync_path(remote_name) {
        IncomingSyncPath::Accept => remote_name.to_owned(),
        IncomingSyncPath::Sanitize(name) => name,
        _ => local_name.to_owned(),
    }
}

fn record_decrypt_failure(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    mut failure: SyncFailure,
) {
    failure.filename = file.name.clone();
    context.summary.failures.push(failure);
}

async fn recreate_local_file(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
    local_hash: String,
    reason: &'static str,
) -> Result<ConflictResolution, SyncErrorKind> {
    create_from_content(
        context, &file.name, local, local_hash, file.size, file.mtime, reason,
    )
    .await
}

async fn resolve_live_remote_conflict(
    context: &mut PushContext<'_>,
    conflict: LiveRemoteConflict<'_>,
) -> Result<ConflictResolution, SyncErrorKind> {
    let remote = match decrypt(context.http, &context.state.vault_key, &conflict.current).await {
        Ok(remote) => remote,
        Err(failure) => {
            record_decrypt_failure(context, conflict.file, failure);
            return Ok(None);
        }
    };
    let remote_name = resolved_remote_name(&remote.name, &conflict.file.name);

    if remote.content == conflict.local && !conflict.local_was_rename {
        return Ok(adopt_matching_remote(
            context,
            conflict.file,
            conflict.local,
            &conflict.local_hash,
            &remote,
            remote_name,
        ));
    }

    if let Some(merged) = merge_remote_content(
        context,
        conflict.file,
        conflict.existing,
        conflict.local,
        &remote,
    )
    .await
    {
        let target = if conflict.local_was_rename {
            conflict.file.name.clone()
        } else {
            remote_name.clone()
        };
        match persist_clean_merge(
            context,
            conflict.file,
            conflict.existing,
            &conflict.response,
            target,
            merged,
            &conflict.local_hash,
        )
        .await?
        {
            MergeAttempt::Applied(result) => return Ok(Some(result)),
            MergeAttempt::Failed => return Ok(None),
            MergeAttempt::NeedsConflictCopy => {}
        }
    }

    write_conflict_pair(
        context,
        conflict.file,
        conflict.local,
        &remote,
        remote_name,
        &conflict.current,
        &conflict.local_hash,
    )
    .await
}

pub(super) async fn resolve_update_conflict(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    local: &str,
    local_hash: String,
    conflict: Conflict,
    local_was_rename: bool,
) -> Result<ConflictResolution, SyncErrorKind> {
    if conflict.current_blob_key.is_none() {
        return recreate_local_file(context, file, local, local_hash, reason::REMOTE_HAS_NO_BLOB)
            .await;
    }

    let Some(current) = fetch_current_object(context, file, existing).await else {
        return Ok(None);
    };
    if current.deleted {
        return recreate_local_file(
            context,
            file,
            local,
            local_hash,
            reason::REMOTE_OBJECT_DELETED,
        )
        .await;
    }

    resolve_live_remote_conflict(
        context,
        LiveRemoteConflict {
            file,
            existing,
            local,
            local_hash,
            response: conflict,
            local_was_rename,
            current,
        },
    )
    .await
}
