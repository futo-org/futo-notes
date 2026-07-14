use std::collections::HashMap;
use std::path::Path;

use futo_notes_core::files::{classify_incoming_sync_path, set_file_mtime_ms, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{self, Ancestry, ConnectedState};
use crate::server::timestamp_ms;
use crate::session::connect::{client, collection_error};

use super::collision_resolution::place_collision;
use super::encrypted_note::{decrypt, state_from_remote, RemoteNote};
use super::object_map::{mapped_name, object_is_current};
use super::outcome::{derive_renames, note_id};
use super::tombstones::{apply_tombstone, recover_stale_claims};
use super::vault::{content_hash, park_local, remove_local, write_content};
use super::{
    FailureKind, PreWrite, Progress, RenamePair, SyncErrorKind, SyncFailure, SyncProgress,
    SyncSummary,
};

fn ancestry_for<'a>(
    ancestry: &'a HashMap<String, Ancestry>,
    object_id: &str,
) -> Option<(&'a str, &'a Ancestry)> {
    ancestry
        .iter()
        .find(|(_, entry)| entry.object_id == object_id)
        .map(|(name, entry)| (name.as_str(), entry))
}

pub(super) fn apply_remote(
    state: &mut ConnectedState,
    root: &Path,
    remote: &RemoteNote,
    ancestry: &HashMap<String, Ancestry>,
    bootstrap: bool,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let requested = match classify_incoming_sync_path(&remote.name) {
        IncomingSyncPath::Ignore => return Ok(()),
        IncomingSyncPath::Accept => remote.name.clone(),
        IncomingSyncPath::Sanitize(name) => name,
        IncomingSyncPath::Reject(_) => {
            summary.failures.push(SyncFailure {
                filename: remote.name.clone(),
                kind: FailureKind::Rejected,
                status_code: None,
            });
            return Ok(());
        }
    };
    let remote_hash = hash_sha256(&remote.content);
    let mut replace_unmapped_target = false;

    if bootstrap {
        if let Some((old_name, ancestor)) = ancestry_for(ancestry, &remote.object.id) {
            if root.join(old_name).exists() {
                let local_hash = content_hash(root, old_name);
                if local_hash.as_deref() == Some(ancestor.hash.as_str()) {
                    replace_unmapped_target = true;
                    if old_name != requested {
                        let _ = remove_local(root, old_name, pre_write)?;
                        summary.deleted_ids.push(note_id(old_name));
                        summary.peer_deleted_ids.push(note_id(old_name));
                    }
                } else if remote_hash == ancestor.hash {
                    let mut entry = state_from_remote(remote);
                    entry.hash = Some(ancestor.hash.clone());
                    entry.mtime_ms = None;
                    entry.size_bytes = None;
                    state.object_map.insert(old_name.to_owned(), entry);
                    return Ok(());
                } else {
                    let copy = park_local(root, old_name, &remote.object.id, pre_write)?;
                    summary.conflicts += 1;
                    summary.local_writes_applied += 1;
                    summary.updated_ids.push(note_id(&copy));
                    summary.peer_updated_ids.push(note_id(&copy));
                }
            }
        }
    }

    let Some(target) = place_collision(state, root, remote, &requested, pre_write, summary)? else {
        return Ok(());
    };

    if let Some(old_name) = mapped_name(state, &remote.object.id) {
        if old_name != target {
            if root.join(&old_name).exists() {
                let expected = state
                    .object_map
                    .get(&old_name)
                    .and_then(|entry| entry.hash.as_deref());
                let current = content_hash(root, &old_name);
                if current.as_deref() == expected {
                    let _ = remove_local(root, &old_name, pre_write)?;
                } else {
                    let copy = park_local(root, &old_name, &remote.object.id, pre_write)?;
                    summary.conflicts += 1;
                    summary.updated_ids.push(note_id(&copy));
                }
            }
            state.object_map.remove(&old_name);
            summary.deleted_ids.push(note_id(&old_name));
            summary.peer_deleted_ids.push(note_id(&old_name));
            summary.renamed.push(RenamePair {
                from_id: note_id(&old_name),
                to_id: note_id(&target),
            });
        }
    }

    let already = state.object_map.get(&target).is_some_and(|entry| {
        entry.object_id == remote.object.id
            && entry.version == remote.object.version
            && entry.blob_key == remote.object.blob_key.as_deref().unwrap_or_default()
    });
    if already {
        return Ok(());
    }

    if root.join(&target).exists()
        && !state.object_map.contains_key(&target)
        && !replace_unmapped_target
    {
        let local_hash = content_hash(root, &target);
        if local_hash.as_deref() != Some(remote_hash.as_str()) {
            let copy = park_local(root, &target, &remote.object.id, pre_write)?;
            summary.conflicts += 1;
            summary.local_writes_applied += 1;
            summary.updated_ids.push(note_id(&copy));
            summary.peer_updated_ids.push(note_id(&copy));
        }
    }

    let needs_content_write = content_hash(root, &target).as_deref() != Some(remote_hash.as_str());
    if needs_content_write {
        write_content(root, &target, &remote.content, pre_write)?;
        summary.local_writes_applied += 1;
    }
    let modified = timestamp_ms(&remote.object.updated_at);
    if modified > 0 {
        pre_write(&target);
        let _ = set_file_mtime_ms(&root.join(&target), modified);
    }
    state
        .object_map
        .insert(target.clone(), state_from_remote(remote));
    summary.downloaded += 1;
    summary.updated_ids.push(note_id(&target));
    summary.peer_updated_ids.push(note_id(&target));
    Ok(())
}

pub(crate) async fn pull(
    state: &ConnectedState,
    root: &Path,
    since: u64,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    recover_stale_claims(root, pre_write);
    let http = client(state)?;
    let objects = http
        .objects(&state.collection_id, since)
        .await
        .map_err(collection_error)?;
    let ancestry = checkpoint::load_ancestry(root);
    let bootstrap = state.object_map.is_empty() && since == 0;
    let mut next = state.clone();
    let mut summary = SyncSummary::default();
    let mut highest = since;
    let mut lowest_failed = None::<u64>;
    progress(SyncProgress {
        phase: "pulling",
        current: 0,
        total: objects.len(),
    });
    for (index, object) in objects.iter().enumerate() {
        highest = highest.max(object.change_seq);
        if object.deleted {
            if apply_tombstone(&mut next, root, object, &ancestry, pre_write, &mut summary).is_err()
            {
                lowest_failed =
                    Some(lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)));
                summary.failures.push(SyncFailure {
                    filename: String::new(),
                    kind: FailureKind::Download,
                    status_code: None,
                });
            }
        } else if let Some(existing_name) = mapped_name(&next, &object.id) {
            let existing = &next.object_map[&existing_name];
            if object_is_current(existing, object) {
                progress(SyncProgress {
                    phase: "pulling",
                    current: index + 1,
                    total: objects.len(),
                });
                continue;
            }
            match decrypt(&http, &next.vault_key, object).await {
                Ok(remote) => {
                    if apply_remote(
                        &mut next,
                        root,
                        &remote,
                        &ancestry,
                        bootstrap,
                        pre_write,
                        &mut summary,
                    )
                    .is_err()
                    {
                        lowest_failed = Some(
                            lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)),
                        );
                        summary.failures.push(SyncFailure {
                            filename: remote.name,
                            kind: FailureKind::Download,
                            status_code: None,
                        });
                    }
                }
                Err(mut failure) => {
                    failure.filename = existing_name;
                    if failure.kind != FailureKind::Rejected {
                        lowest_failed = Some(
                            lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)),
                        );
                    }
                    summary.failures.push(failure);
                }
            }
        } else {
            match decrypt(&http, &next.vault_key, object).await {
                Ok(remote) => {
                    if apply_remote(
                        &mut next,
                        root,
                        &remote,
                        &ancestry,
                        bootstrap,
                        pre_write,
                        &mut summary,
                    )
                    .is_err()
                    {
                        lowest_failed = Some(
                            lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)),
                        );
                        summary.failures.push(SyncFailure {
                            filename: remote.name,
                            kind: FailureKind::Download,
                            status_code: None,
                        });
                    }
                }
                Err(failure) => {
                    lowest_failed =
                        Some(lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)));
                    summary.failures.push(failure);
                }
            }
        }
        progress(SyncProgress {
            phase: "pulling",
            current: index + 1,
            total: objects.len(),
        });
    }
    let cursor = cap_cursor(highest, lowest_failed);
    for rename in derive_renames(&state.object_map, &next.object_map) {
        if !summary
            .renamed
            .iter()
            .any(|existing| existing.from_id == rename.from_id && existing.to_id == rename.to_id)
        {
            summary.renamed.push(rename);
        }
    }
    next.max_version = cursor;
    next.pull_cursor = cursor;
    checkpoint::save(root, &next).map_err(SyncErrorKind::Io)?;
    if lowest_failed.is_none() {
        checkpoint::clear_ancestry(root);
    }
    Ok((summary, next))
}

pub(super) fn cap_cursor(highest: u64, lowest_failed: Option<u64>) -> u64 {
    lowest_failed
        .map(|failed| highest.min(failed.saturating_sub(1)))
        .unwrap_or(highest)
}
