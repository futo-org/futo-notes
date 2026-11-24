use std::collections::HashMap;
use std::path::Path;

use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{Ancestry, ConnectedState, ObjectState};
use crate::server::timestamp_ms;
use crate::sync::collision_resolution::place_collision;
use crate::sync::encrypted_note::{state_from_remote, RemoteNote};
use crate::sync::object_map::{mapped_name, object_is_current};
use crate::sync::outcome::note_id;
use crate::sync::vault::{
    adopt_local, content_hash, park_local, path_exists, rename_local, write_content_if_changed,
    PulledWrite,
};
use crate::sync::vault_fs;
use crate::sync::{
    decision, FailureKind, PreWrite, RenamePair, SyncFailure, SyncPhase, SyncSummary,
};

pub(super) mod reason {
    pub(super) const UNSUPPORTED_NAME: &str = "unsupported_incoming_name";
    pub(super) const UNPORTABLE_NAME: &str = "unportable_incoming_name";
    pub(super) const BOOTSTRAP_LOCAL_DIVERGED: &str = "bootstrap_local_diverged_from_ancestor";
    pub(super) const MAPPING_MOVED: &str = "server_moved_the_mapped_name";
    pub(super) const OLD_NAME_DIVERGED: &str = "old_name_diverged_from_map";
    pub(super) const UNMAPPED_TARGET_OCCUPIED: &str = "unmapped_target_holds_other_content";
    pub(super) const REMOTE_VERSION_IS_NEWER: &str = "remote_version_is_newer";
    pub(in crate::sync::pull) const APPLY_ERROR: &str = "apply_error";
}

fn ancestry_for<'a>(
    ancestry: &'a HashMap<String, Ancestry>,
    object_id: &str,
) -> Option<(&'a str, &'a Ancestry)> {
    ancestry
        .iter()
        .find(|(_, entry)| entry.object_id == object_id)
        .map(|(name, entry)| (name.as_str(), entry))
}

struct ApplyContext<'a> {
    state: &'a mut ConnectedState,
    root: &'a Path,
    ancestry: &'a HashMap<String, Ancestry>,
    bootstrap: bool,
    pre_write: &'a PreWrite,
    summary: &'a mut SyncSummary,
}

fn requested_path(remote: &RemoteNote, summary: &mut SyncSummary) -> Option<String> {
    match classify_incoming_sync_path(&remote.name) {
        // Ignored: left strictly alone, never a failure. A non-note file is
        // noise and stays silent; a name no portable filesystem can hold gets a
        // journal line, because it is the answer to "why is that note not on
        // this device" and the journal is the one channel the user never sees.
        IncomingSyncPath::Ignore(why) => {
            if why == futo_notes_core::files::IGNORE_UNPORTABLE_NAME {
                summary.decide(
                    SyncPhase::Pull,
                    &remote.name,
                    decision::IGNORED,
                    reason::UNPORTABLE_NAME,
                );
            }
            None
        }
        IncomingSyncPath::Accept => Some(remote.name.clone()),
        IncomingSyncPath::Sanitize(name) => Some(name),
        IncomingSyncPath::Reject(why) => {
            summary.failures.push(SyncFailure {
                filename: remote.name.clone(),
                kind: FailureKind::Rejected,
                status_code: None,
                detail: Some(why.to_string()),
            });
            summary.decide(
                SyncPhase::Pull,
                &remote.name,
                decision::FAILED,
                reason::UNSUPPORTED_NAME,
            );
            None
        }
    }
}

#[derive(PartialEq)]
enum BootstrapAction {
    Continue,
    Complete,
}

fn reconcile_bootstrap_ancestry(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    remote_hash: &str,
) -> Result<BootstrapAction, String> {
    if !context.bootstrap {
        return Ok(BootstrapAction::Continue);
    }
    let Some((old_name, ancestor)) = ancestry_for(context.ancestry, &remote.object.id) else {
        return Ok(BootstrapAction::Continue);
    };
    if !path_exists(context.root, old_name)? {
        return Ok(BootstrapAction::Continue);
    }

    let local_hash = content_hash(context.root, old_name);
    if local_hash.as_deref() == Some(ancestor.hash.as_str()) {
        // The object's last synced copy, unchanged: mapped as that object so the
        // pull moves and fast-forwards it like any mapped note, and a step that
        // fails leaves it mapped for the next pull rather than unmapped for the
        // push. Version 0: the ancestry records none, and the server holds none
        // older.
        context.state.object_map.insert(
            old_name.to_owned(),
            ObjectState {
                object_id: remote.object.id.clone(),
                version: 0,
                blob_key: String::new(),
                hash: local_hash,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        return Ok(BootstrapAction::Continue);
    }
    if remote_hash == ancestor.hash {
        let mut entry = state_from_remote(remote);
        entry.hash = Some(ancestor.hash.clone());
        entry.mtime_ms = None;
        entry.size_bytes = None;
        context.state.object_map.insert(old_name.to_owned(), entry);
        return Ok(BootstrapAction::Complete);
    }

    let copy = park_local(context.root, old_name, &remote.object.id, context.pre_write)?;
    context.summary.conflicts += 1;
    context.summary.local_writes_applied += 1;
    context.summary.updated_ids.push(note_id(&copy));
    context.summary.peer_updated_ids.push(note_id(&copy));
    context.summary.decide_with(
        SyncPhase::Pull,
        old_name,
        decision::PARKED_LOCAL,
        reason::BOOTSTRAP_LOCAL_DIVERGED,
        copy,
    );
    Ok(BootstrapAction::Continue)
}

/// The server moved the object from the name it is mapped at to `target`. The
/// note moves there (`rename_local`, which reports the move under its guard
/// hold) and takes its mapping along, so `commit_remote_file` fast-forwards it
/// from the mapped hash. Every step leaves one mapped name holding the note on
/// disk: a refused rename changes nothing, a target already holding the pulled
/// bytes (which `preserve_unmapped_target` accepts) is adopted, a failed
/// write leaves the target
/// mapped at the previous version for the next pull, and a save landing in
/// between makes the write refuse instead of overwrite. Written to the target
/// first, a move that then failed left the push an unmapped duplicate, or a
/// mapped name missing from disk to delete.
fn move_mapped_note(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    target: &str,
    remote_hash: &str,
) -> Result<(), String> {
    let Some(old_name) = mapped_name(context.state, &remote.object.id) else {
        return Ok(());
    };
    if old_name == target {
        return Ok(());
    }
    let (root, pre_write) = (context.root, context.pre_write);
    let entry = context.state.object_map[&old_name].clone();
    // Gone: nothing moves, and the target is written as a fresh pull.
    if path_exists(root, &old_name)? {
        if entry.hash.is_none() || content_hash(root, &old_name) != entry.hash {
            // A local save since the last sync: kept as a conflict copy, and
            // the target written as a fresh pull.
            park_moved(context, remote, &old_name)?;
        } else {
            // A case-only move on a volume that folds case names one file twice.
            let one_file = vault_fs::same_file(root, &old_name, target);
            if !one_file {
                preserve_unmapped_target(context, remote, target, remote_hash)?;
            }
            pre_write(&old_name);
            pre_write(target);
            // An unmapped target already holding the pulled bytes is adopted:
            // the old name is removed instead of moved onto it.
            let adopts = !one_file
                && !context.state.object_map.contains_key(target)
                && content_hash(root, target).as_deref() == Some(remote_hash);
            let moved = if adopts {
                adopt_local(root, &old_name, target, remote_hash)?
            } else {
                rename_local(root, &old_name, target)?
            };
            if moved {
                context.state.object_map.insert(target.to_owned(), entry);
            }
        }
    }
    context.state.object_map.remove(&old_name);
    let summary = &mut *context.summary;
    summary.deleted_ids.push(note_id(&old_name));
    summary.peer_deleted_ids.push(note_id(&old_name));
    summary.renamed.push(RenamePair {
        from_id: note_id(&old_name),
        to_id: note_id(target),
    });
    summary.decide_with(
        SyncPhase::Pull,
        &old_name,
        decision::RELOCATED,
        reason::MAPPING_MOVED,
        target.to_owned(),
    );
    Ok(())
}

/// Keeps a local save to the note the object moved away from as a conflict
/// copy; `park_local` reports the move.
fn park_moved(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    name: &str,
) -> Result<(), String> {
    let copy = park_local(context.root, name, &remote.object.id, context.pre_write)?;
    context.summary.conflicts += 1;
    context.summary.updated_ids.push(note_id(&copy));
    context.summary.decide_with(
        SyncPhase::Pull,
        name,
        decision::PARKED_LOCAL,
        reason::OLD_NAME_DIVERGED,
        copy,
    );
    Ok(())
}

fn preserve_unmapped_target(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    target: &str,
    remote_hash: &str,
) -> Result<(), String> {
    if !path_exists(context.root, target)? || context.state.object_map.contains_key(target) {
        return Ok(());
    }
    let local_hash = content_hash(context.root, target);
    if local_hash.as_deref() == Some(remote_hash) {
        return Ok(());
    }
    let copy = park_local(context.root, target, &remote.object.id, context.pre_write)?;
    context.summary.conflicts += 1;
    context.summary.local_writes_applied += 1;
    context.summary.updated_ids.push(note_id(&copy));
    context.summary.peer_updated_ids.push(note_id(&copy));
    context.summary.decide_with(
        SyncPhase::Pull,
        target,
        decision::PARKED_LOCAL,
        reason::UNMAPPED_TARGET_OCCUPIED,
        copy,
    );
    Ok(())
}

fn commit_remote_file(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    target: String,
    remote_hash: &str,
) -> Result<(), String> {
    let local_base = context
        .state
        .object_map
        .get(&target)
        .and_then(|entry| entry.hash.clone());
    let modified = timestamp_ms(&remote.object.updated_at);
    match write_content_if_changed(
        context.root,
        &target,
        &remote.content,
        remote_hash,
        local_base.as_deref(),
        modified,
        context.pre_write,
    )? {
        PulledWrite::Written => context.summary.local_writes_applied += 1,
        PulledWrite::AlreadyCurrent => {}
        PulledWrite::LocalChanged => {
            return Err(format!(
                "local revision changed before applying remote object {}",
                remote.object.id
            ))
        }
    }
    context
        .state
        .object_map
        .insert(target.clone(), state_from_remote(remote));
    context.summary.downloaded += 1;
    context.summary.updated_ids.push(note_id(&target));
    context.summary.peer_updated_ids.push(note_id(&target));
    context.summary.decide(
        SyncPhase::Pull,
        &target,
        decision::DOWNLOADED,
        reason::REMOTE_VERSION_IS_NEWER,
    );
    Ok(())
}

pub(in crate::sync) fn apply_remote(
    state: &mut ConnectedState,
    root: &Path,
    remote: &RemoteNote,
    ancestry: &HashMap<String, Ancestry>,
    bootstrap: bool,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let Some(requested) = requested_path(remote, summary) else {
        return Ok(());
    };
    let mut context = ApplyContext {
        state,
        root,
        ancestry,
        bootstrap,
        pre_write,
        summary,
    };
    let remote_hash = hash_sha256(&remote.content);
    if reconcile_bootstrap_ancestry(&mut context, remote, &remote_hash)?
        == BootstrapAction::Complete
    {
        return Ok(());
    }
    let Some(target) = place_collision(
        context.state,
        context.root,
        remote,
        &requested,
        context.pre_write,
        context.summary,
    )?
    else {
        return Ok(());
    };
    let already = context
        .state
        .object_map
        .get(&target)
        .is_some_and(|entry| object_is_current(entry, &remote.object));
    move_mapped_note(&mut context, remote, &target, &remote_hash)?;
    if !already {
        preserve_unmapped_target(&mut context, remote, &target, &remote_hash)?;
        commit_remote_file(&mut context, remote, target, &remote_hash)?;
    }
    Ok(())
}
