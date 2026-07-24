use std::collections::HashMap;
use std::path::Path;

use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{self, Ancestry, ConnectedState};
use crate::server::{timestamp_ms, Http, Object};
use crate::session::connect::{client, collection_error};

use super::collision_resolution::place_collision;
use super::encrypted_note::{decrypt, state_from_remote, RemoteNote};
use super::object_map::{mapped_name, object_is_current};
use super::outcome::{append_derived_renames, note_id, record_checkpoint_failure};
use super::tombstones::{apply_tombstone, recover_stale_claims};
use super::vault::{content_hash, park_local, path_exists, remove_local, write_content};
use super::vault_fs;
use super::{
    FailureKind, PreWrite, Progress, RenamePair, SaveCheckpoint, SyncErrorKind, SyncFailure,
    SyncProgress, SyncSummary,
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
        }
    }
    context.state.object_map.remove(&old_name);
    context.summary.deleted_ids.push(note_id(&old_name));
    context.summary.peer_deleted_ids.push(note_id(&old_name));
    context.summary.renamed.push(RenamePair {
        from_id: note_id(&old_name),
        to_id: note_id(target),
    });
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
    Ok(())
}

fn commit_remote_file(
    context: &mut ApplyContext<'_>,
    remote: &RemoteNote,
    target: String,
    remote_hash: &str,
) -> Result<(), String> {
    if content_hash(context.root, &target).as_deref() != Some(remote_hash) {
        write_content(context.root, &target, &remote.content, context.pre_write)?;
        context.summary.local_writes_applied += 1;
    }
    let modified = timestamp_ms(&remote.object.updated_at);
    if modified > 0 {
        (context.pre_write)(&target);
        let _ = vault_fs::set_mtime_ms(context.root, &target, modified);
    }
    context
        .state
        .object_map
        .insert(target.clone(), state_from_remote(remote));
    context.summary.downloaded += 1;
    context.summary.updated_ids.push(note_id(&target));
    context.summary.peer_updated_ids.push(note_id(&target));
    Ok(())
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

struct PullCursor {
    highest: u64,
    lowest_failed: Option<u64>,
}

impl PullCursor {
    fn new(since: u64) -> Self {
        Self {
            highest: since,
            lowest_failed: None,
        }
    }

    fn observe(&mut self, change_seq: u64) {
        self.highest = self.highest.max(change_seq);
    }

    fn fail(&mut self, change_seq: u64) {
        self.lowest_failed = Some(
            self.lowest_failed
                .map_or(change_seq, |current| current.min(change_seq)),
        );
    }

    fn value(&self) -> u64 {
        cap_cursor(self.highest, self.lowest_failed)
    }

    fn has_failures(&self) -> bool {
        self.lowest_failed.is_some()
    }
}

struct PullContext<'a> {
    http: &'a Http,
    state: &'a mut ConnectedState,
    root: &'a Path,
    ancestry: &'a HashMap<String, Ancestry>,
    bootstrap: bool,
    pre_write: &'a PreWrite,
    summary: &'a mut SyncSummary,
    cursor: &'a mut PullCursor,
}

fn record_apply_failure(context: &mut PullContext<'_>, object: &Object, filename: String) {
    context.cursor.fail(object.change_seq);
    context.summary.failures.push(SyncFailure {
        filename,
        kind: FailureKind::Download,
        status_code: None,
    });
}

async fn apply_live_object(context: &mut PullContext<'_>, object: &Object) {
    let existing_name = mapped_name(context.state, &object.id);
    if existing_name
        .as_ref()
        .is_some_and(|name| object_is_current(&context.state.object_map[name], object))
    {
        return;
    }

    match decrypt(context.http, &context.state.vault_key, object).await {
        Ok(remote) => {
            if apply_remote(
                context.state,
                context.root,
                &remote,
                context.ancestry,
                context.bootstrap,
                context.pre_write,
                context.summary,
            )
            .is_err()
            {
                record_apply_failure(context, object, remote.name);
            }
        }
        Err(mut failure) => {
            if let Some(existing_name) = existing_name {
                failure.filename = existing_name;
                if failure.kind != FailureKind::Rejected {
                    context.cursor.fail(object.change_seq);
                }
            } else {
                context.cursor.fail(object.change_seq);
            }
            context.summary.failures.push(failure);
        }
    }
}

async fn apply_object(context: &mut PullContext<'_>, object: &Object) {
    if !object.deleted {
        apply_live_object(context, object).await;
        return;
    }
    if apply_tombstone(
        context.state,
        context.root,
        object,
        context.ancestry,
        context.pre_write,
        context.summary,
    )
    .is_err()
    {
        record_apply_failure(context, object, String::new());
    }
}

pub(crate) async fn pull(
    state: &ConnectedState,
    root: &Path,
    since: u64,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    pull_with_checkpoint(state, root, since, progress, pre_write, &checkpoint::save).await
}

pub(crate) async fn pull_with_checkpoint(
    state: &ConnectedState,
    root: &Path,
    since: u64,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
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
    let mut cursor = PullCursor::new(since);
    progress(SyncProgress {
        phase: "pulling",
        current: 0,
        total: objects.len(),
    });
    for (index, object) in objects.iter().enumerate() {
        cursor.observe(object.change_seq);
        apply_object(
            &mut PullContext {
                http: &http,
                state: &mut next,
                root,
                ancestry: &ancestry,
                bootstrap,
                pre_write,
                summary: &mut summary,
                cursor: &mut cursor,
            },
            object,
        )
        .await;
        progress(SyncProgress {
            phase: "pulling",
            current: index + 1,
            total: objects.len(),
        });
    }
    append_derived_renames(&mut summary, &state.object_map, &next.object_map);
    next.max_version = cursor.value();
    next.pull_cursor = cursor.value();
    let checkpoint_saved = save_checkpoint(root, &next).is_ok();
    if !checkpoint_saved {
        record_checkpoint_failure(&mut summary);
    }
    if checkpoint_saved && !cursor.has_failures() {
        checkpoint::clear_ancestry(root);
    }
    Ok((summary, next))
}

pub(super) fn cap_cursor(highest: u64, lowest_failed: Option<u64>) -> u64 {
    lowest_failed
        .map(|failed| highest.min(failed.saturating_sub(1)))
        .unwrap_or(highest)
}
