use std::collections::HashSet;

use futo_notes_core::e2ee::{self, conflict_filename, MergeResult};
use futo_notes_core::files::{classify_incoming_sync_path, set_file_mtime_ms, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::is_image_filename;

use crate::checkpoint::ObjectState;
use crate::server::{timestamp_ms, Conflict, Mutation};

use super::encrypted_note::{decrypt, encrypt, object_state, state_from_remote};
use super::outcome::note_id;
use super::push::{create_fresh, PushContext, Upload};
use super::vault::{conflict_date, local_files, remove_local, write_content, LocalFile};
use super::{FailureKind, RenamePair, SyncFailure};

pub(super) async fn resolve_update_conflict(
    context: PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    local: &str,
    local_hash: String,
    conflict: Conflict,
    local_was_rename: bool,
) -> Option<(String, ObjectState)> {
    if conflict.current_blob_key.is_none() {
        return create_fresh(
            context.http,
            &mut *context.state,
            Upload {
                name: &file.name,
                content: local,
                hash: local_hash,
                size: file.size,
                mtime: file.mtime,
            },
            &mut *context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state));
    }
    let current = match context
        .http
        .object(&context.state.collection_id, &existing.object_id)
        .await
    {
        Ok(object) => object,
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: error.status,
            });
            return None;
        }
    };
    if current.deleted {
        return create_fresh(
            context.http,
            &mut *context.state,
            Upload {
                name: &file.name,
                content: local,
                hash: local_hash,
                size: file.size,
                mtime: file.mtime,
            },
            &mut *context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state));
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
        if let Some(modified) = state_from_remote(&remote).mtime_ms {
            (context.pre_write)(&remote_name);
            let _ = set_file_mtime_ms(&context.root.join(&remote_name), modified);
        }
        return Some((remote_name, state_from_remote(&remote)));
    }
    let base = match context.http.blob(&existing.blob_key).await {
        Ok(ciphertext) => e2ee::aes_gcm_decrypt(&context.state.vault_key, &ciphertext)
            .ok()
            .and_then(|plain| e2ee::unpack_note(&plain).ok())
            .map(|note| note.content),
        Err(_) => None,
    };
    let merged = if remote.content == local {
        Some(local.to_owned())
    } else if is_image_filename(&file.name) {
        None
    } else {
        base.and_then(
            |base| match e2ee::three_way_merge_text(&base, &remote.content, local) {
                MergeResult::Clean(merged) => Some(merged),
                MergeResult::Conflict => None,
            },
        )
    };
    if let Some(merged) = merged {
        let target = if local_was_rename {
            file.name.clone()
        } else {
            remote_name.clone()
        };
        let merged_hash = hash_sha256(&merged);
        let ciphertext = encrypt(&context.state.vault_key, &target, &merged).ok()?;
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
            Ok(Mutation::Written(write)) if write.object.deleted => {
                return create_fresh(
                    context.http,
                    &mut *context.state,
                    Upload {
                        name: &target,
                        content: &merged,
                        hash: merged_hash,
                        size: merged.len() as u64,
                        mtime: file.mtime,
                    },
                    &mut *context.summary,
                )
                .await
                .map(|state| (target, state));
            }
            Ok(Mutation::Written(write)) => {
                if write_content(context.root, &target, &merged, context.pre_write).is_err()
                    || (target != file.name
                        && remove_local(context.root, &file.name, context.pre_write).is_err())
                {
                    context.summary.failures.push(SyncFailure {
                        filename: file.name.clone(),
                        kind: FailureKind::Upload,
                        status_code: None,
                    });
                    return None;
                }
                let modified = timestamp_ms(&write.object.updated_at);
                let _ = set_file_mtime_ms(&context.root.join(&target), modified);
                context.state.max_version = context.state.max_version.max(write.collection_version);
                context.summary.uploaded += 1;
                context.summary.local_writes_applied += 1;
                context.summary.updated_ids.push(note_id(&target));
                if target != file.name {
                    context.summary.deleted_ids.push(note_id(&file.name));
                    context.summary.renamed.push(RenamePair {
                        from_id: note_id(&file.name),
                        to_id: note_id(&target),
                    });
                }
                return Some((
                    target,
                    object_state(&write, merged_hash, merged.len() as u64),
                ));
            }
            Err(error) if error.is(413) => {
                context
                    .state
                    .oversize_skip
                    .insert(file.name.clone(), file.mtime);
                context.summary.conflicts += 1;
                return None;
            }
            _ => {}
        }
    }

    let names: HashSet<String> = local_files(context.root)
        .into_iter()
        .map(|f| f.name)
        .collect();
    let copy = conflict_filename(&file.name, &conflict_date(), &names);
    if write_content(context.root, &copy, local, context.pre_write).is_err() {
        context.summary.failures.push(SyncFailure {
            filename: file.name.clone(),
            kind: FailureKind::Upload,
            status_code: None,
        });
        return None;
    }
    let copy_hash = hash_sha256(local);
    if let Some(entry) = create_fresh(
        context.http,
        &mut *context.state,
        Upload {
            name: &copy,
            content: local,
            hash: copy_hash,
            size: local.len() as u64,
            mtime: file.mtime,
        },
        &mut *context.summary,
    )
    .await
    {
        context.state.object_map.insert(copy.clone(), entry);
    }
    if write_content(
        context.root,
        &remote_name,
        &remote.content,
        context.pre_write,
    )
    .is_ok()
        && (remote_name == file.name
            || remove_local(context.root, &file.name, context.pre_write).is_ok())
    {
        let modified = timestamp_ms(&current.updated_at);
        let _ = set_file_mtime_ms(&context.root.join(&remote_name), modified);
        context.summary.local_writes_applied += 2;
        context.summary.conflicts += 1;
        context.summary.updated_ids.push(note_id(&remote_name));
        context.summary.updated_ids.push(note_id(&copy));
        context.summary.peer_updated_ids.push(note_id(&remote_name));
        if remote_name != file.name {
            context.summary.deleted_ids.push(note_id(&file.name));
            context.summary.renamed.push(RenamePair {
                from_id: note_id(&file.name),
                to_id: note_id(&remote_name),
            });
        }
    }
    Some((remote_name, state_from_remote(&remote)))
}
