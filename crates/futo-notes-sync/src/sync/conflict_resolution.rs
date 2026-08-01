use std::collections::HashSet;

use futo_notes_core::conflict_names::conflict_filename;
use futo_notes_core::e2ee;
use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::is_image_filename;
use futo_notes_core::merge::{three_way_merge, MergeResult};

use crate::checkpoint::ObjectState;
use crate::server::{timestamp_ms, Conflict, Mutation, Object, Write};

use super::encrypted_note::{decrypt, encrypt, object_state, state_from_remote, RemoteNote};
use super::outcome::note_id;
use super::push::{create_fresh, PushContext, Upload};
use super::vault::{conflict_date, local_files, remove_local, write_content, LocalFile};
use super::vault_fs;
use super::{decision, FailureKind, RenamePair, SyncFailure, SyncPhase};

/// Reasons an update conflict resolves the way it does.
mod reason {
    pub(super) const REMOTE_ALREADY_HOLDS_LOCAL: &str = "remote_already_holds_local_content";
    pub(super) const THREE_WAY_MERGE_WAS_CLEAN: &str = "three_way_merge_was_clean";
    pub(super) const MERGE_IMPOSSIBLE: &str = "concurrent_edit_could_not_merge";
    pub(super) const SERVER_REJECTED_413: &str = "server_rejected_413";
    pub(super) const REMOTE_OBJECT_DELETED: &str = "remote_object_was_deleted";
    pub(super) const CONFLICT_COPY_UPLOAD: &str = "conflict_copy_upload";
    pub(super) const REMOTE_HAS_NO_BLOB: &str = "remote_object_has_no_blob";
}

async fn create_from_content(
    context: &mut PushContext<'_>,
    name: &str,
    content: &str,
    hash: String,
    size: u64,
    mtime: i64,
    reason: &'static str,
) -> Option<(String, ObjectState)> {
    create_fresh(
        context.http,
        context.state,
        Upload {
            name,
            content,
            hash,
            size,
            mtime,
            reason,
        },
        context.summary,
    )
    .await
    .map(|state| (name.to_owned(), state))
}

async fn fetch_current(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
) -> Option<Object> {
    match context
        .http
        .object(&context.state.collection_id, &existing.object_id)
        .await
    {
        Ok(object) => Some(object),
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: error.status,
            });
            None
        }
    }
}

fn adopt_matching_remote(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
    remote: &RemoteNote,
    remote_name: String,
) -> Option<(String, ObjectState)> {
    if remote_name != file.name {
        if write_content(context.root, &remote_name, local, context.pre_write).is_err()
            || remove_local(context.root, &file.name, context.pre_write).is_err()
        {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
        context.summary.local_writes_applied += 1;
        context.summary.deleted_ids.push(note_id(&file.name));
        context.summary.updated_ids.push(note_id(&remote_name));
        context.summary.peer_updated_ids.push(note_id(&remote_name));
        context.summary.renamed.push(RenamePair {
            from_id: note_id(&file.name),
            to_id: note_id(&remote_name),
        });
    }
    if let Some(modified) = state_from_remote(remote).mtime_ms {
        (context.pre_write)(&remote_name);
        let _ = vault_fs::set_mtime_ms(context.root, &remote_name, modified);
    }
    context.summary.decide_with(
        SyncPhase::Push,
        &file.name,
        decision::ADOPTED_REMOTE,
        reason::REMOTE_ALREADY_HOLDS_LOCAL,
        remote_name.clone(),
    );
    Some((remote_name, state_from_remote(remote)))
}

async fn merge_content(
    context: &PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    local: &str,
    remote: &RemoteNote,
) -> Option<String> {
    if remote.content == local {
        return Some(local.to_owned());
    }
    if is_image_filename(&file.name) {
        return None;
    }
    let base = context
        .http
        .blob(&existing.blob_key, existing.size_bytes.unwrap_or(0))
        .await
        .ok()
        .and_then(|ciphertext| e2ee::aes_gcm_decrypt(&context.state.vault_key, &ciphertext).ok())
        .and_then(|plain| e2ee::unpack_note(&plain).ok())
        .map(|note| note.content);
    base.and_then(
        |base| match three_way_merge(&base, &remote.content, local) {
            MergeResult::Clean(merged) => Some(merged),
            MergeResult::Conflict => None,
        },
    )
}

enum MergeAttempt {
    Applied((String, ObjectState)),
    Failed,
    NeedsConflictCopy,
}

fn apply_merged_write(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    target: String,
    merged: &str,
    merged_hash: String,
    write: Write,
) -> MergeAttempt {
    if write_content(context.root, &target, merged, context.pre_write).is_err()
        || (target != file.name
            && remove_local(context.root, &file.name, context.pre_write).is_err())
    {
        context.summary.failures.push(SyncFailure {
            filename: file.name.clone(),
            kind: FailureKind::Upload,
            status_code: None,
        });
        return MergeAttempt::Failed;
    }
    let modified = timestamp_ms(&write.object.updated_at);
    let _ = vault_fs::set_mtime_ms(context.root, &target, modified);
    context.state.max_version = context.state.max_version.max(write.collection_version);
    context.summary.uploaded += 1;
    context.summary.local_writes_applied += 1;
    context.summary.decide_with(
        SyncPhase::Push,
        &file.name,
        decision::MERGED,
        reason::THREE_WAY_MERGE_WAS_CLEAN,
        target.clone(),
    );
    context.summary.updated_ids.push(note_id(&target));
    if target != file.name {
        context.summary.deleted_ids.push(note_id(&file.name));
        context.summary.renamed.push(RenamePair {
            from_id: note_id(&file.name),
            to_id: note_id(&target),
        });
    }
    MergeAttempt::Applied((
        target,
        object_state(&write, merged_hash, merged.len() as u64),
    ))
}

async fn persist_clean_merge(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    conflict: &Conflict,
    target: String,
    merged: String,
) -> MergeAttempt {
    let merged_hash = hash_sha256(&merged);
    let Ok(ciphertext) = encrypt(&context.state.vault_key, &target, &merged) else {
        return MergeAttempt::Failed;
    };
    match context
        .http
        .update_object(
            &context.state.collection_id,
            &existing.object_id,
            conflict.current_version + 1,
            ciphertext,
        )
        .await
    {
        Ok(Mutation::Written(write)) if write.object.deleted => create_from_content(
            context,
            &target,
            &merged,
            merged_hash,
            merged.len() as u64,
            file.mtime,
            reason::REMOTE_OBJECT_DELETED,
        )
        .await
        .map(MergeAttempt::Applied)
        .unwrap_or(MergeAttempt::Failed),
        Ok(Mutation::Written(write)) => {
            apply_merged_write(context, file, target, &merged, merged_hash, write)
        }
        Err(error) if error.is(413) => {
            context
                .state
                .oversize_skip
                .insert(file.name.clone(), file.mtime);
            context.summary.conflicts += 1;
            context.summary.decide(
                SyncPhase::Push,
                &file.name,
                decision::SKIPPED_OVERSIZE,
                reason::SERVER_REJECTED_413,
            );
            MergeAttempt::Failed
        }
        _ => MergeAttempt::NeedsConflictCopy,
    }
}

async fn create_conflict_copy(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
) -> Option<String> {
    let names: HashSet<String> = match local_files(context.root) {
        Ok(files) => files.into_iter().map(|file| file.name).collect(),
        Err(_) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
    };
    let copy = conflict_filename(&file.name, &conflict_date(), &names);
    if write_content(context.root, &copy, local, context.pre_write).is_err() {
        context.summary.failures.push(SyncFailure {
            filename: file.name.clone(),
            kind: FailureKind::Upload,
            status_code: None,
        });
        return None;
    }
    if let Some((_, entry)) = create_from_content(
        context,
        &copy,
        local,
        hash_sha256(local),
        local.len() as u64,
        file.mtime,
        reason::CONFLICT_COPY_UPLOAD,
    )
    .await
    {
        context.state.object_map.insert(copy.clone(), entry);
    }
    Some(copy)
}

fn try_adopt_remote_conflict_winner(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    remote: &RemoteNote,
    remote_name: &str,
    copy: &str,
    current: &Object,
) -> Result<(), String> {
    write_content(
        context.root,
        remote_name,
        &remote.content,
        context.pre_write,
    )?;
    if remote_name != file.name {
        remove_local(context.root, &file.name, context.pre_write)?;
    }
    let modified = timestamp_ms(&current.updated_at);
    let _ = vault_fs::set_mtime_ms(context.root, remote_name, modified);
    context.summary.local_writes_applied += 2;
    context.summary.conflicts += 1;
    context.summary.updated_ids.push(note_id(remote_name));
    context.summary.updated_ids.push(note_id(copy));
    context.summary.peer_updated_ids.push(note_id(remote_name));
    if remote_name != file.name {
        context.summary.deleted_ids.push(note_id(&file.name));
        context.summary.renamed.push(RenamePair {
            from_id: note_id(&file.name),
            to_id: note_id(remote_name),
        });
    }
    Ok(())
}

async fn write_conflict_pair(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
    remote: &RemoteNote,
    remote_name: String,
    current: &Object,
) -> Option<(String, ObjectState)> {
    let copy = create_conflict_copy(context, file, local).await?;
    if try_adopt_remote_conflict_winner(context, file, remote, &remote_name, &copy, current)
        .is_err()
    {
        context.summary.failures.push(SyncFailure {
            filename: file.name.clone(),
            kind: FailureKind::Upload,
            status_code: None,
        });
        return None;
    }
    context.summary.decide_with(
        SyncPhase::Push,
        &file.name,
        decision::CONFLICT_COPY,
        reason::MERGE_IMPOSSIBLE,
        copy,
    );
    Some((remote_name, state_from_remote(remote)))
}

pub(super) async fn resolve_update_conflict(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    local: &str,
    local_hash: String,
    conflict: Conflict,
    local_was_rename: bool,
) -> Option<(String, ObjectState)> {
    if conflict.current_blob_key.is_none() {
        return create_from_content(
            context,
            &file.name,
            local,
            local_hash,
            file.size,
            file.mtime,
            reason::REMOTE_HAS_NO_BLOB,
        )
        .await;
    }
    let current = fetch_current(context, file, existing).await?;
    if current.deleted {
        return create_from_content(
            context,
            &file.name,
            local,
            local_hash,
            file.size,
            file.mtime,
            reason::REMOTE_OBJECT_DELETED,
        )
        .await;
    }
    let remote = match decrypt(context.http, &context.state.vault_key, &current).await {
        Ok(remote) => remote,
        Err(mut failure) => {
            failure.filename = file.name.clone();
            context.summary.failures.push(failure);
            return None;
        }
    };
    let remote_name = match classify_incoming_sync_path(&remote.name) {
        IncomingSyncPath::Accept => remote.name.clone(),
        IncomingSyncPath::Sanitize(name) => name,
        _ => file.name.clone(),
    };
    if remote.content == local && !local_was_rename {
        return adopt_matching_remote(context, file, local, &remote, remote_name);
    }
    if let Some(merged) = merge_content(context, file, existing, local, &remote).await {
        let target = if local_was_rename {
            file.name.clone()
        } else {
            remote_name.clone()
        };
        match persist_clean_merge(context, file, existing, &conflict, target, merged).await {
            MergeAttempt::Applied(result) => return Some(result),
            MergeAttempt::Failed => return None,
            MergeAttempt::NeedsConflictCopy => {}
        }
    }
    write_conflict_pair(context, file, local, &remote, remote_name, &current).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use crate::checkpoint::ConnectedState;
    use crate::server::stalled_http::{
        allow_network_task_to_settle, allow_timeout_task_to_finish, HangingServer, StallPoint,
    };
    use crate::server::Http;

    use super::super::outcome::SyncSummary;
    use super::*;

    fn no_pre(_: &str) {}

    #[tokio::test(start_paused = true)]
    async fn merge_base_fetch_deadline_scales_with_checkpoint_size() {
        let server = HangingServer::new(StallPoint::ResponseHeaders);
        let base_url = server.base_url.clone();
        let request = tokio::spawn(async move {
            let http = Http::new(&base_url).unwrap().token("token");
            let mut state = ConnectedState {
                base_url,
                token: "token".into(),
                user_id: "user".into(),
                collection_id: "collection".into(),
                vault_key: [5; 32],
                object_map: HashMap::new(),
                max_version: 0,
                pull_cursor: 0,
                oversize_skip: HashMap::new(),
            };
            let mut summary = SyncSummary::default();
            let root = std::env::temp_dir();
            let context = PushContext {
                http: &http,
                state: &mut state,
                root: &root,
                summary: &mut summary,
                pre_write: &no_pre,
            };
            let existing = ObjectState {
                object_id: "o1".into(),
                version: 1,
                blob_key: "blob-o1".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: Some(128 * 1024),
            };
            let file = LocalFile {
                name: "a.md".into(),
                mtime: 0,
                size: 5,
            };
            let remote = RemoteNote {
                object: Object {
                    id: "o1".into(),
                    version: 2,
                    change_seq: 2,
                    deleted: false,
                    blob_key: Some("blob-o1-v2".into()),
                    size_bytes: None,
                    updated_at: "2026-06-05T12:34:56.789Z".into(),
                },
                name: "a.md".into(),
                content: "remote".into(),
            };
            merge_content(&context, &file, &existing, "local", &remote).await
        });
        server.wait_for_request().await;
        allow_network_task_to_settle().await;

        tokio::time::advance(Duration::from_secs(30) + Duration::from_millis(1)).await;
        allow_timeout_task_to_finish(&request).await;
        assert!(
            !request.is_finished(),
            "merge-base fetch ignored the checkpoint-recorded size"
        );

        tokio::time::advance(Duration::from_secs(1)).await;
        allow_timeout_task_to_finish(&request).await;
        assert!(
            request.is_finished(),
            "merge-base fetch had no finite deadline"
        );
        assert_eq!(request.await.unwrap(), None);
    }
}
