use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::checkpoint::{self, Ancestry, ConnectedState};
use crate::server::Object;
use crate::session::connect::{client, collection_error};

use super::encrypted_note::RemoteNote;
use super::object_map::{mapped_name, object_is_current};
use super::outcome::{append_derived_renames, record_checkpoint_failure};
use super::tombstones::{apply_tombstone, recover_stale_claims};
use super::transfer::download_executor::download_stage;
use super::{
    decision, FailureKind, PreWrite, Progress, SaveCheckpoint, SyncErrorKind, SyncFailure,
    SyncPhase, SyncSummary,
};

mod apply_remote;
#[cfg(test)]
mod tests;

pub(super) use apply_remote::apply_remote;

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
    state: &'a mut ConnectedState,
    root: &'a Path,
    ancestry: &'a HashMap<String, Ancestry>,
    bootstrap: bool,
    pre_write: &'a PreWrite,
    summary: &'a mut SyncSummary,
    cursor: &'a mut PullCursor,
}

/// A local write failed after the blob was already downloaded and decrypted.
///
/// The kind turns on one question — is the vault folder still there? — because
/// that is the only cause the user can act on from the message alone, and it is
/// checked here rather than at the start of the cycle so a folder that goes away
/// mid-cycle (an unmounted drive, a revoked document-portal grant, a
/// cloud-sync client renaming it) is caught too. Everything else is a local
/// write fault: no permission, a read-only mount, a full disk, a symlink or a
/// plain file where a folder belongs, or a local edit that landed mid-pull.
///
/// Neither is a download failure, which is what all of them used to report
/// (github#44). The engine's own error text goes to the journal — nowhere else
/// records it, and "apply_error" alone answered nothing.
fn record_apply_failure(
    context: &mut PullContext<'_>,
    object: &Object,
    filename: String,
    error: String,
) {
    context.cursor.fail(object.change_seq);
    let vault_missing = !context.root.is_dir();
    let (kind, reason) = if vault_missing {
        (FailureKind::VaultMissing, reason::VAULT_MISSING)
    } else {
        (FailureKind::LocalApply, apply_remote::reason::APPLY_ERROR)
    };
    context.summary.decide_with(
        SyncPhase::Pull,
        &filename,
        decision::FAILED,
        reason,
        error.clone(),
    );
    context.summary.failures.push(SyncFailure {
        // The vault clause names the folder, so that is what its failure
        // carries; a per-note fault still names the note.
        filename: if vault_missing {
            context.root.display().to_string()
        } else {
            filename
        },
        kind,
        status_code: None,
        detail: Some(error),
    });
}

pub(super) mod reason {
    pub(super) const VAULT_MISSING: &str = "vault_folder_missing";
    pub(super) const DOWNLOAD_FAILED: &str = "download_failed";
}

fn apply_live_object(
    context: &mut PullContext<'_>,
    object: &Object,
    downloaded: Result<RemoteNote, SyncFailure>,
) {
    let existing_name = mapped_name(context.state, &object.id);
    if existing_name
        .as_ref()
        .is_some_and(|name| object_is_current(&context.state.object_map[name], object))
    {
        return;
    }

    match downloaded {
        Ok(remote) => {
            if let Err(error) = apply_remote(
                context.state,
                context.root,
                &remote,
                context.ancestry,
                context.bootstrap,
                context.pre_write,
                context.summary,
            ) {
                record_apply_failure(context, object, remote.name, error);
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
            // A download or decrypt failure journaled nothing at all, so the
            // one channel built to answer "why is that note not on this device"
            // was silent for the two causes it was most needed for. The status
            // is the fallback when the transport gave no message.
            let detail = failure.detail.clone().unwrap_or_else(|| {
                failure
                    .status_code
                    .map_or_else(|| failure.kind.as_str().to_owned(), |s| format!("HTTP {s}"))
            });
            context.summary.decide_with(
                SyncPhase::Pull,
                &failure.filename,
                decision::FAILED,
                reason::DOWNLOAD_FAILED,
                detail,
            );
            context.summary.failures.push(failure);
        }
    }
}

fn observe_remote_changes(cursor: &mut PullCursor, objects: &[Object]) {
    for object in objects {
        cursor.observe(object.change_seq);
    }
}

fn apply_remote_tombstones(
    context: &mut PullContext<'_>,
    objects: &[Object],
    restart_cursor: u64,
    protected_paths: &HashSet<String>,
) -> Result<(), SyncErrorKind> {
    for object in objects.iter().filter(|object| object.deleted) {
        if mapped_name(context.state, &object.id)
            .is_some_and(|name| protected_paths.contains(&name))
        {
            context.cursor.fail(object.change_seq);
            continue;
        }
        if let Err(error) = apply_tombstone(
            context.state,
            context.root,
            object,
            context.ancestry,
            context.pre_write,
            context.summary,
        ) {
            record_apply_failure(context, object, String::new(), error);
        }
        context.state.pull_cursor = restart_cursor;
        checkpoint::save(context.root, context.state).map_err(SyncErrorKind::Io)?;
    }
    Ok(())
}

fn pending_live_downloads(
    state: &ConnectedState,
    objects: &[Object],
    protected_paths: &HashSet<String>,
    cursor: &mut PullCursor,
) -> Vec<Object> {
    objects
        .iter()
        .filter(|object| !object.deleted)
        .filter(|object| {
            let Some(name) = mapped_name(state, &object.id) else {
                return true;
            };
            if object_is_current(&state.object_map[&name], object) {
                return false;
            }
            if protected_paths.contains(&name) {
                cursor.fail(object.change_seq);
                return false;
            }
            true
        })
        .cloned()
        .collect()
}

fn apply_completed_downloads(
    context: &mut PullContext<'_>,
    completed: Vec<(Object, Result<RemoteNote, SyncFailure>)>,
) {
    for (object, downloaded) in completed {
        apply_live_object(context, &object, downloaded);
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
    pull_with_checkpoint_protected(
        state,
        root,
        since,
        progress,
        pre_write,
        save_checkpoint,
        &HashSet::new(),
    )
    .await
}

pub(super) async fn pull_with_checkpoint_protected(
    state: &ConnectedState,
    root: &Path,
    since: u64,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
    protected_paths: &HashSet<String>,
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
    observe_remote_changes(&mut cursor, &objects);
    apply_remote_tombstones(
        &mut PullContext {
            state: &mut next,
            root,
            ancestry: &ancestry,
            bootstrap,
            pre_write,
            summary: &mut summary,
            cursor: &mut cursor,
        },
        &objects,
        since,
        protected_paths,
    )?;

    let pending_downloads = pending_live_downloads(&next, &objects, protected_paths, &mut cursor);
    let vault_key = next.vault_key;
    download_stage(
        &http,
        &vault_key,
        pending_downloads,
        progress,
        |completed| {
            apply_completed_downloads(
                &mut PullContext {
                    state: &mut next,
                    root,
                    ancestry: &ancestry,
                    bootstrap,
                    pre_write,
                    summary: &mut summary,
                    cursor: &mut cursor,
                },
                completed,
            );
            next.pull_cursor = since;
            checkpoint::save(root, &next).map_err(SyncErrorKind::Io)
        },
    )
    .await?;
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
