use std::collections::HashMap;
use std::path::Path;

use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{Ancestry, ConnectedState};
use crate::server::timestamp_ms;
use crate::sync::collision_resolution::place_collision;
use crate::sync::encrypted_note::{state_from_remote, RemoteNote};
use crate::sync::object_map::mapped_name;
use crate::sync::outcome::note_id;
use crate::sync::vault::{
    content_hash, park_local, path_exists, remove_local, write_content_if_changed,
};
use crate::sync::{
    decision, FailureKind, PreWrite, RenamePair, SyncFailure, SyncPhase, SyncSummary,
};

pub(super) mod reason {
    pub(super) const UNSUPPORTED_NAME: &str = "unsupported_incoming_name";
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
        IncomingSyncPath::Ignore => None,
        IncomingSyncPath::Accept => Some(remote.name.clone()),
        IncomingSyncPath::Sanitize(name) => Some(name),
        IncomingSyncPath::Reject(_) => {
            summary.failures.push(SyncFailure {
                filename: remote.name.clone(),
                kind: FailureKind::Rejected,
                status_code: None,
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

enum BootstrapAction {
    Continue { replace_unmapped_target: bool },
    Complete,
}

fn reconcile_bootstrap_ancestry(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    requested: &str,
    remote_hash: &str,
) -> Result<BootstrapAction, String> {
    if !context.bootstrap {
        return Ok(BootstrapAction::Continue {
            replace_unmapped_target: false,
        });
    }
    let Some((old_name, ancestor)) = ancestry_for(context.ancestry, &remote.object.id) else {
        return Ok(BootstrapAction::Continue {
            replace_unmapped_target: false,
        });
    };
    if !path_exists(context.root, old_name)? {
        return Ok(BootstrapAction::Continue {
            replace_unmapped_target: false,
        });
    }

    let local_hash = content_hash(context.root, old_name);
    if local_hash.as_deref() == Some(ancestor.hash.as_str()) {
        if old_name != requested {
            let _ = remove_local(context.root, old_name, context.pre_write)?;
            context.summary.deleted_ids.push(note_id(old_name));
            context.summary.peer_deleted_ids.push(note_id(old_name));
        }
        return Ok(BootstrapAction::Continue {
            replace_unmapped_target: true,
        });
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
    Ok(BootstrapAction::Continue {
        replace_unmapped_target: false,
    })
}

fn relocate_existing_mapping(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    target: &str,
) -> Result<(), String> {
    let Some(old_name) = mapped_name(context.state, &remote.object.id) else {
        return Ok(());
    };
    if old_name == target {
        return Ok(());
    }
    if path_exists(context.root, &old_name)? {
        let expected = context
            .state
            .object_map
            .get(&old_name)
            .and_then(|entry| entry.hash.as_deref());
        let current = content_hash(context.root, &old_name);
        if current.as_deref() == expected {
            let _ = remove_local(context.root, &old_name, context.pre_write)?;
        } else {
            let copy = park_local(
                context.root,
                &old_name,
                &remote.object.id,
                context.pre_write,
            )?;
            context.summary.conflicts += 1;
            context.summary.updated_ids.push(note_id(&copy));
            context.summary.decide_with(
                SyncPhase::Pull,
                &old_name,
                decision::PARKED_LOCAL,
                reason::OLD_NAME_DIVERGED,
                copy,
            );
        }
    }
    context.state.object_map.remove(&old_name);
    context.summary.deleted_ids.push(note_id(&old_name));
    context.summary.peer_deleted_ids.push(note_id(&old_name));
    context.summary.renamed.push(RenamePair {
        from_id: note_id(&old_name),
        to_id: note_id(target),
    });
    context.summary.decide_with(
        SyncPhase::Pull,
        &old_name,
        decision::RELOCATED,
        reason::MAPPING_MOVED,
        target.to_owned(),
    );
    Ok(())
}

fn preserve_unmapped_target(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    target: &str,
    remote_hash: &str,
    replace_unmapped_target: bool,
) -> Result<(), String> {
    if !path_exists(context.root, target)?
        || context.state.object_map.contains_key(target)
        || replace_unmapped_target
    {
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
    if let Some(expected) = context
        .state
        .object_map
        .get(&target)
        .and_then(|entry| entry.hash.as_deref())
    {
        let current = content_hash(context.root, &target);
        if current.as_deref() != Some(expected) && current.as_deref() != Some(remote_hash) {
            return Err(format!(
                "local revision changed before applying remote object {}",
                remote.object.id
            ));
        }
    }
    let modified = timestamp_ms(&remote.object.updated_at);
    if write_content_if_changed(
        context.root,
        &target,
        &remote.content,
        remote_hash,
        modified,
        context.pre_write,
    )? {
        context.summary.local_writes_applied += 1;
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
    let replace_unmapped_target =
        match reconcile_bootstrap_ancestry(&mut context, remote, &requested, &remote_hash)? {
            BootstrapAction::Continue {
                replace_unmapped_target,
            } => replace_unmapped_target,
            BootstrapAction::Complete => return Ok(()),
        };
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
    relocate_existing_mapping(&mut context, remote, &target)?;
    let already = context.state.object_map.get(&target).is_some_and(|entry| {
        entry.object_id == remote.object.id
            && entry.version == remote.object.version
            && entry.blob_key == remote.object.blob_key.as_deref().unwrap_or_default()
    });
    if already {
        return Ok(());
    }
    preserve_unmapped_target(
        &mut context,
        remote,
        &target,
        &remote_hash,
        replace_unmapped_target,
    )?;
    commit_remote_file(&mut context, remote, target, &remote_hash)
}
