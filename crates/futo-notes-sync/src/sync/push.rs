use std::collections::{HashMap, HashSet};
use std::path::Path;

use futo_notes_core::files::{classify_incoming_sync_path, set_file_mtime_ms, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::is_syncable_filename;

use crate::checkpoint::{self, ConnectedState, ObjectState};
use crate::server::{Http, Mutation};
use crate::session::connect::{client, collection_error};

use super::conflict_resolution::resolve_update_conflict;
use super::encrypted_note::{decrypt, encrypt, object_state, state_from_remote};
use super::outcome::{derive_renames, note_id};
use super::tombstones::recover_stale_claims;
use super::vault::{local_files, read_content, write_content, LocalFile};
use super::{
    FailureKind, PreWrite, Progress, RenamePair, SyncErrorKind, SyncFailure, SyncProgress,
    SyncSummary,
};

pub(super) struct Upload<'a> {
    pub(super) name: &'a str,
    pub(super) content: &'a str,
    pub(super) hash: String,
    pub(super) size: u64,
    pub(super) mtime: i64,
}

pub(super) async fn create_fresh(
    http: &Http,
    state: &mut ConnectedState,
    upload: Upload<'_>,
    summary: &mut SyncSummary,
) -> Option<ObjectState> {
    let ciphertext = match encrypt(&state.vault_key, upload.name, upload.content) {
        Ok(ciphertext) => ciphertext,
        Err(_) => {
            summary.failures.push(SyncFailure {
                filename: upload.name.into(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
    };
    match http.create_object(&state.collection_id, ciphertext).await {
        Ok(write) => {
            state.max_version = state.max_version.max(write.collection_version);
            state.oversize_skip.remove(upload.name);
            summary.uploaded += 1;
            Some(object_state(&write, upload.hash, upload.size))
        }
        Err(error) if error.is(413) => {
            state.oversize_skip.insert(upload.name.into(), upload.mtime);
            summary.conflicts += 1;
            None
        }
        Err(error) => {
            summary.failures.push(SyncFailure {
                filename: upload.name.into(),
                kind: FailureKind::Upload,
                status_code: error.status,
            });
            None
        }
    }
}

pub(super) struct PushContext<'a> {
    pub(super) http: &'a Http,
    pub(super) state: &'a mut ConnectedState,
    pub(super) root: &'a Path,
    pub(super) summary: &'a mut SyncSummary,
    pub(super) pre_write: &'a PreWrite,
}

async fn update_existing(
    context: PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    content: &str,
    hash: String,
    local_was_rename: bool,
) -> Option<(String, ObjectState)> {
    let ciphertext = match encrypt(&context.state.vault_key, &file.name, content) {
        Ok(ciphertext) => ciphertext,
        Err(_) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
    };
    match context
        .http
        .update_object(
            &context.state.collection_id,
            &existing.object_id,
            existing.version + 1,
            ciphertext,
        )
        .await
    {
        Ok(Mutation::Written(write)) if write.object.deleted => create_fresh(
            context.http,
            context.state,
            Upload {
                name: &file.name,
                content,
                hash,
                size: file.size,
                mtime: file.mtime,
            },
            context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state)),
        Ok(Mutation::Written(write)) => {
            context.state.max_version = context.state.max_version.max(write.collection_version);
            context.state.oversize_skip.remove(&file.name);
            context.summary.uploaded += 1;
            Some((file.name.clone(), object_state(&write, hash, file.size)))
        }
        Ok(Mutation::Conflict(conflict)) => {
            resolve_update_conflict(
                context,
                file,
                existing,
                content,
                hash,
                conflict,
                local_was_rename,
            )
            .await
        }
        Err(error) if error.is(413) => {
            context
                .state
                .oversize_skip
                .insert(file.name.clone(), file.mtime);
            context.summary.conflicts += 1;
            None
        }
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

pub(crate) async fn push(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    recover_stale_claims(root, pre_write);
    let http = client(state)?;
    let mut next = state.clone();
    let files = local_files(root);
    let local_names: HashSet<String> = files.iter().map(|f| f.name.clone()).collect();
    let missing: Vec<(String, ObjectState)> = next
        .object_map
        .iter()
        .filter(|(name, _)| !local_names.contains(*name))
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect();
    let mut summary = SyncSummary::default();

    let mut hashes = HashMap::new();
    let unmapped: Vec<_> = files
        .iter()
        .filter(|file| !next.object_map.contains_key(&file.name))
        .cloned()
        .collect();
    for file in &unmapped {
        if let Ok(content) = read_content(root, &file.name) {
            hashes.insert(file.name.clone(), hash_sha256(&content));
        }
    }
    let mut claimed_missing = HashSet::new();
    let mut renamed_files = HashSet::new();
    for file in &unmapped {
        let Some(hash) = hashes.get(&file.name) else {
            continue;
        };
        let basename = file.name.rsplit('/').next().unwrap_or(&file.name);
        let candidates: Vec<_> = missing
            .iter()
            .filter(|(old, entry)| {
                !claimed_missing.contains(old)
                    && entry.hash.as_ref() == Some(hash)
                    && old.rsplit('/').next().unwrap_or(old) == basename
            })
            .collect();
        if candidates.len() == 1 {
            let (old, entry) = candidates[0];
            next.object_map.remove(old);
            next.object_map.insert(file.name.clone(), entry.clone());
            claimed_missing.insert(old.clone());
            renamed_files.insert(file.name.clone());
            summary.renamed.push(RenamePair {
                from_id: note_id(old),
                to_id: note_id(&file.name),
            });
        }
    }

    progress(SyncProgress {
        phase: "pushing",
        current: 0,
        total: files.len() + missing.len(),
    });
    let mut completed = 0usize;
    for file in &files {
        if next.oversize_skip.get(&file.name) == Some(&file.mtime) {
            summary.conflicts += 1;
            completed += 1;
            continue;
        }
        let existing = next.object_map.get(&file.name).cloned();
        if !renamed_files.contains(&file.name)
            && existing.as_ref().is_some_and(|entry| {
                entry.mtime_ms == Some(file.mtime) && entry.size_bytes == Some(file.size)
            })
        {
            completed += 1;
            continue;
        }
        let content = match read_content(root, &file.name) {
            Ok(content) => content,
            Err(_) => {
                summary.failures.push(SyncFailure {
                    filename: file.name.clone(),
                    kind: FailureKind::Upload,
                    status_code: None,
                });
                completed += 1;
                continue;
            }
        };
        let hash = hash_sha256(&content);
        if let Some(mut entry) = existing.clone() {
            if !renamed_files.contains(&file.name) && entry.hash.as_ref() == Some(&hash) {
                if let Some(server_mtime) = entry.mtime_ms {
                    if server_mtime != file.mtime {
                        pre_write(&file.name);
                        let _ = set_file_mtime_ms(&root.join(&file.name), server_mtime);
                    }
                }
                entry.size_bytes = Some(file.size);
                next.object_map.insert(file.name.clone(), entry);
                completed += 1;
                continue;
            }
        }
        let result = match existing.as_ref() {
            Some(entry) => {
                update_existing(
                    PushContext {
                        http: &http,
                        state: &mut next,
                        root,
                        summary: &mut summary,
                        pre_write,
                    },
                    file,
                    entry,
                    &content,
                    hash,
                    renamed_files.contains(&file.name),
                )
                .await
            }
            None => create_fresh(
                &http,
                &mut next,
                Upload {
                    name: &file.name,
                    content: &content,
                    hash,
                    size: file.size,
                    mtime: file.mtime,
                },
                &mut summary,
            )
            .await
            .map(|state| (file.name.clone(), state)),
        };
        if let Some((target, entry)) = result {
            if let Some(modified) = entry.mtime_ms {
                pre_write(&target);
                let _ = set_file_mtime_ms(&root.join(&target), modified);
            }
            if target != file.name {
                next.object_map.remove(&file.name);
            }
            next.object_map.insert(target, entry);
        }
        completed += 1;
        progress(SyncProgress {
            phase: "pushing",
            current: completed,
            total: files.len() + missing.len(),
        });
        if completed % 50 == 0
            && checkpoint::save(root, &next).is_err()
            && !summary
                .failures
                .iter()
                .any(|f| f.kind == FailureKind::Checkpoint)
        {
            summary.failures.push(SyncFailure {
                filename: String::new(),
                kind: FailureKind::Checkpoint,
                status_code: None,
            });
        }
    }

    let deleted: Vec<_> = missing
        .into_iter()
        .filter(|(name, _)| !claimed_missing.contains(name))
        .filter(|(name, _)| is_syncable_filename(name))
        .filter_map(|(name, _)| {
            next.object_map
                .get(&name)
                .cloned()
                .map(|entry| (name, entry))
        })
        .collect();
    for (name, entry) in deleted {
        match http
            .delete_object(&next.collection_id, &entry.object_id, entry.version)
            .await
        {
            Ok(Mutation::Written(write)) => {
                next.max_version = next.max_version.max(write.collection_version);
                next.object_map.remove(&name);
                summary.deleted += 1;
                summary.deleted_ids.push(note_id(&name));
            }
            Ok(Mutation::Conflict(_)) => {
                let current = http
                    .object(&next.collection_id, &entry.object_id)
                    .await
                    .map_err(collection_error)?;
                if let Ok(remote) = decrypt(&http, &next.vault_key, &current).await {
                    let target = match classify_incoming_sync_path(&remote.name) {
                        IncomingSyncPath::Accept => remote.name.clone(),
                        IncomingSyncPath::Sanitize(name) => name,
                        _ => name.clone(),
                    };
                    write_content(root, &target, &remote.content, pre_write)
                        .map_err(SyncErrorKind::Io)?;
                    let remote_state = state_from_remote(&remote);
                    if let Some(mtime) = remote_state.mtime_ms {
                        let _ = set_file_mtime_ms(&root.join(&target), mtime);
                    }
                    next.object_map.remove(&name);
                    next.object_map.insert(target.clone(), remote_state);
                    summary.downloaded += 1;
                    summary.conflicts += 1;
                    summary.local_writes_applied += 1;
                    summary.peer_updated_ids.push(note_id(&target));
                }
            }
            Err(error) => summary.failures.push(SyncFailure {
                filename: name,
                kind: FailureKind::Delete,
                status_code: error.status,
            }),
        }
    }
    for rename in derive_renames(&state.object_map, &next.object_map) {
        if !summary
            .renamed
            .iter()
            .any(|existing| existing.from_id == rename.from_id && existing.to_id == rename.to_id)
        {
            summary.renamed.push(rename);
        }
    }
    checkpoint::save(root, &next).map_err(SyncErrorKind::Io)?;
    Ok((summary, next))
}
