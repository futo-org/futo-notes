use std::collections::HashSet;
use std::path::Path;

use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{ConnectedState, ObjectState, PendingCreate};
use crate::server::{Http, HttpError};
use crate::sync::vault::{read_content, LocalFile};
use crate::sync::{FailureKind, SyncErrorKind, SyncFailure, SyncSummary};

fn matching_local_successors(
    state: &ConnectedState,
    root: &Path,
    files: &[LocalFile],
    pending: &PendingCreate,
) -> Result<Vec<String>, SyncErrorKind> {
    let basename = pending
        .original_name
        .rsplit('/')
        .next()
        .unwrap_or(&pending.original_name);
    let mut matches = Vec::new();
    for file in files.iter().filter(|file| {
        !state.object_map.contains_key(&file.name)
            && !state.pending_creates.contains_key(&file.name)
            && file.name.rsplit('/').next().unwrap_or(&file.name) == basename
    }) {
        let content = read_content(root, &file.name).map_err(SyncErrorKind::Io)?;
        if hash_sha256(&content) == pending.hash {
            matches.push(file.name.clone());
        }
    }
    Ok(matches)
}

async fn recover_missing_pending_create(
    http: &Http,
    state: &mut ConnectedState,
    name: String,
    pending: PendingCreate,
    summary: &mut SyncSummary,
) -> Result<(), SyncErrorKind> {
    let object = match http
        .create_mutation(&state.collection_id, &pending.mutation_id)
        .await
    {
        Ok(created) => created.write.object,
        Err(error) if error.is(404) => {
            state.pending_creates.remove(&name);
            return Ok(());
        }
        Err(error) => {
            summary.failures.push(SyncFailure {
                filename: name,
                kind: FailureKind::Upload,
                status_code: error.status,
                detail: Some(error.message.clone()),
            });
            return Err(pending_create_recovery_error(&error));
        }
    };
    state.pending_creates.remove(&name);
    if !object.deleted {
        state.object_map.insert(
            name,
            ObjectState {
                object_id: object.id,
                version: 1,
                blob_key: object.blob_key.unwrap_or_default(),
                hash: Some(pending.hash),
                mtime_ms: None,
                size_bytes: Some(pending.size_bytes),
            },
        );
    }
    Ok(())
}

fn pending_create_recovery_error(error: &HttpError) -> SyncErrorKind {
    let message = error
        .status
        .map(|status| {
            format!("pending create recovery unresolved (HTTP {status}); stopping before pull")
        })
        .unwrap_or_else(|| "pending create recovery unresolved; stopping before pull".into());
    if error.is(401) {
        SyncErrorKind::Auth(message)
    } else {
        SyncErrorKind::Http(message)
    }
}

pub(in crate::sync) async fn recover_pending_creates(
    http: &Http,
    state: &mut ConnectedState,
    root: &Path,
    files: &[LocalFile],
    summary: &mut SyncSummary,
) -> Result<HashSet<String>, SyncErrorKind> {
    let settled_ids: HashSet<_> = state
        .object_map
        .values()
        .map(|entry| entry.object_id.as_str())
        .collect();
    state
        .pending_creates
        .retain(|_, pending| !settled_ids.contains(pending.mutation_id.as_str()));

    let local_names: HashSet<_> = files.iter().map(|file| file.name.as_str()).collect();
    let pending = state
        .pending_creates
        .iter()
        .map(|(name, pending)| (name.clone(), pending.clone()))
        .collect::<Vec<_>>();
    let mut blocked = HashSet::new();

    for (name, pending) in pending {
        if local_names.contains(name.as_str()) {
            continue;
        }
        let mut matches = matching_local_successors(state, root, files, &pending)?;
        if matches.len() == 1 {
            state.pending_creates.remove(&name);
            state.pending_creates.insert(matches.remove(0), pending);
            continue;
        }
        if matches.len() > 1 {
            blocked.extend(matches);
            summary.failures.push(SyncFailure {
                filename: name,
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some("more than one local successor claims this pending create".into()),
            });
            continue;
        }

        recover_missing_pending_create(http, state, name, pending, summary).await?;
    }
    Ok(blocked)
}
