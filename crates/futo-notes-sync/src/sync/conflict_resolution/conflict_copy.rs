use std::collections::HashSet;

use futo_notes_core::conflict_names::conflict_filename;
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::ObjectState;
use crate::server::{timestamp_ms, Object};

use super::super::encrypted_note::{state_from_remote, RemoteNote};
use super::super::outcome::note_id;
use super::super::push::PushContext;
use super::super::vault::{conflict_date, copy_content_if_hash_matches, local_files, LocalFile};
use super::super::{decision, FailureKind, RenamePair, SyncErrorKind, SyncFailure, SyncPhase};
use super::guarded_adoption::{replace_with_source_fallback, GuardedReplacement};
use super::{create_from_content, reason};

fn conflict_copy_name(context: &mut PushContext<'_>, file: &LocalFile) -> Option<String> {
    let names: HashSet<String> = match local_files(context.root) {
        Ok(files) => files.into_iter().map(|file| file.name).collect(),
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error),
            });
            return None;
        }
    };
    Some(conflict_filename(&file.name, &conflict_date(), &names))
}

async fn create_conflict_copy(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
    local_hash: &str,
) -> Result<Option<String>, SyncErrorKind> {
    let Some(copy) = conflict_copy_name(context, file) else {
        return Ok(None);
    };
    let copied = copy_content_if_hash_matches(
        context.root,
        &file.name,
        &copy,
        local,
        local_hash,
        context.pre_write,
    );
    if !matches!(copied, Ok(true)) {
        if let Err(error) = copied {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error),
            });
        }
        return Ok(None);
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
    .await?
    {
        context.state.object_map.insert(copy.clone(), entry);
    }
    Ok(Some(copy))
}

fn record_conflict_pair(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    copy: &str,
    settled_name: &str,
) {
    context.summary.local_writes_applied += 2;
    context.summary.conflicts += 1;
    context.summary.updated_ids.push(note_id(settled_name));
    context.summary.updated_ids.push(note_id(copy));
    context.summary.peer_updated_ids.push(note_id(settled_name));
    if settled_name != file.name {
        context.summary.deleted_ids.push(note_id(&file.name));
        context.summary.renamed.push(RenamePair {
            from_id: note_id(&file.name),
            to_id: note_id(settled_name),
        });
    }
    context.summary.decide_with(
        SyncPhase::Push,
        &file.name,
        decision::CONFLICT_COPY,
        reason::MERGE_IMPOSSIBLE,
        copy.to_owned(),
    );
}

fn adopt_remote_conflict_winner(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    remote: &RemoteNote,
    remote_name: &str,
    copy: &str,
    current: &Object,
    local_hash: &str,
) -> Result<Option<String>, String> {
    let replacement = replace_with_source_fallback(
        context,
        file,
        remote_name,
        &remote.content,
        local_hash,
        timestamp_ms(&current.updated_at),
    )?;
    let GuardedReplacement::Applied(settled_name) = replacement else {
        return Ok(None);
    };
    record_conflict_pair(context, file, copy, &settled_name);
    Ok(Some(settled_name))
}

fn preserve_changed_source(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    copy: &str,
    remote: &RemoteNote,
) -> (String, ObjectState) {
    context.summary.local_writes_applied += 1;
    context.summary.conflicts += 1;
    context.summary.updated_ids.push(note_id(copy));
    let mut entry = state_from_remote(remote);
    entry.mtime_ms = None;
    (file.name.clone(), entry)
}

pub(super) async fn write_conflict_pair(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
    remote: &RemoteNote,
    remote_name: String,
    current: &Object,
    local_hash: &str,
) -> Result<Option<(String, ObjectState)>, SyncErrorKind> {
    let Some(copy) = create_conflict_copy(context, file, local, local_hash).await? else {
        return Ok(None);
    };
    match adopt_remote_conflict_winner(
        context,
        file,
        remote,
        &remote_name,
        &copy,
        current,
        local_hash,
    ) {
        Ok(Some(settled_name)) => Ok(Some((settled_name, state_from_remote(remote)))),
        Ok(None) => Ok(Some(preserve_changed_source(context, file, &copy, remote))),
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error),
            });
            Ok(None)
        }
    }
}
