use std::collections::HashSet;
use std::path::Path;

use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::ConnectedState;
use crate::sync::outcome::record_checkpoint_failure;
use crate::sync::transfer::http_transport::UploadDispatcher;
use crate::sync::transfer::{CompletedUpload, UploadTarget};
use crate::sync::vault::{read_content, LocalFile};
use crate::sync::vault_fs;
use crate::sync::{Progress, SaveCheckpoint, SyncErrorKind, SyncProgress, SyncSummary};

use crate::sync::push::local_changes::prepare_upload;
use crate::sync::push::PushContext;

mod create_identity;
mod settlement;
#[cfg(test)]
mod tests;

pub(in crate::sync) use create_identity::{create_fresh, recover_pending_creates, Upload};

#[derive(Clone, Copy, Eq, PartialEq)]
enum CandidateDiskState {
    Matches,
    Changed,
    Missing,
}

fn candidate_disk_state(
    root: &Path,
    candidate: &crate::sync::transfer::UploadCandidate,
) -> CandidateDiskState {
    match vault_fs::exists(root, &candidate.file.name) {
        Ok(false) => CandidateDiskState::Missing,
        Ok(true) => match read_content(root, &candidate.file.name) {
            Ok(content) if hash_sha256(&content) == candidate.hash => CandidateDiskState::Matches,
            _ => CandidateDiskState::Changed,
        },
        Err(_) => CandidateDiskState::Changed,
    }
}

fn checkpoint_progress(
    root: &Path,
    state: &ConnectedState,
    summary: &mut SyncSummary,
    completed: usize,
    save_checkpoint: &SaveCheckpoint,
) {
    if completed % 50 == 0 && save_checkpoint(root, state).is_err() {
        record_checkpoint_failure(summary);
    }
}

fn checkpoint_completed_chunk(
    root: &Path,
    state: &ConnectedState,
    summary: &mut SyncSummary,
    save_checkpoint: &SaveCheckpoint,
) {
    if save_checkpoint(root, state).is_err() {
        record_checkpoint_failure(summary);
    }
}

fn save_required_create_identities(
    root: &Path,
    state: &ConnectedState,
    save_checkpoint: &SaveCheckpoint,
) -> Result<(), SyncErrorKind> {
    save_checkpoint(root, state).map_err(SyncErrorKind::Io)
}

pub(super) struct UploadApplyContext<'a> {
    pub(super) push: PushContext<'a>,
    pub(super) progress: &'a Progress,
    pub(super) progress_total: usize,
    pub(super) completed: usize,
}

impl UploadApplyContext<'_> {
    pub(super) async fn apply(
        &mut self,
        completed_uploads: Vec<CompletedUpload>,
    ) -> Result<(), SyncErrorKind> {
        for (candidate, result) in completed_uploads {
            settlement::apply_candidate(&mut self.push, candidate, result).await?;
            self.completed += 1;
            (self.progress)(SyncProgress {
                phase: "pushing",
                current: self.completed,
                total: self.progress_total,
            });
            checkpoint_progress(
                self.push.root,
                self.push.state,
                self.push.summary,
                self.completed,
                self.push.save_checkpoint,
            );
        }
        Ok(())
    }

    pub(super) fn checkpoint_chunk(&mut self) {
        checkpoint_completed_chunk(
            self.push.root,
            self.push.state,
            self.push.summary,
            self.push.save_checkpoint,
        );
    }
}

pub(in crate::sync) struct UploadFiles<'a> {
    pub(in crate::sync) context: PushContext<'a>,
    pub(in crate::sync) files: &'a [LocalFile],
    pub(in crate::sync) blocked_pending: &'a HashSet<String>,
    pub(in crate::sync) renamed_files: &'a HashSet<String>,
    pub(in crate::sync) progress: &'a Progress,
    pub(in crate::sync) progress_total: usize,
}

pub(in crate::sync) async fn upload_local_files(
    input: UploadFiles<'_>,
) -> Result<(), SyncErrorKind> {
    let UploadFiles {
        context,
        files,
        blocked_pending,
        renamed_files,
        progress,
        progress_total,
    } = input;
    let mut dispatcher = UploadDispatcher::new(context.http, &context.state.collection_id);
    let mut apply_context = UploadApplyContext {
        push: context,
        progress,
        progress_total,
        completed: 0,
    };
    let mut has_uncheckpointed_create = false;

    for file in files {
        if blocked_pending.contains(&file.name) {
            continue;
        }
        if dispatcher.is_at_capacity() {
            let ready = dispatcher
                .next_completed()
                .await
                .expect("capacity implies an active upload task");
            apply_context.apply(ready).await?;
            apply_context.checkpoint_chunk();
        }
        let Some(candidate) = prepare_upload(
            &mut apply_context.push,
            file,
            renamed_files.contains(&file.name),
        ) else {
            continue;
        };
        let is_create = matches!(candidate.target, UploadTarget::Create(_));
        let will_dispatch = dispatcher.will_dispatch(&candidate);
        if will_dispatch && (has_uncheckpointed_create || is_create) {
            save_required_create_identities(
                apply_context.push.root,
                apply_context.push.state,
                apply_context.push.save_checkpoint,
            )?;
            has_uncheckpointed_create = false;
        }
        let ready = dispatcher.push(candidate).await;
        has_uncheckpointed_create |= is_create && !will_dispatch;
        if !ready.is_empty() {
            apply_context.apply(ready).await?;
            apply_context.checkpoint_chunk();
        }
    }

    if dispatcher.has_buffered() {
        if has_uncheckpointed_create {
            save_required_create_identities(
                apply_context.push.root,
                apply_context.push.state,
                apply_context.push.save_checkpoint,
            )?;
        }
        let ready = dispatcher.flush().await;
        if !ready.is_empty() {
            apply_context.apply(ready).await?;
            apply_context.checkpoint_chunk();
        }
    }
    while let Some(ready) = dispatcher.next_completed().await {
        apply_context.apply(ready).await?;
        apply_context.checkpoint_chunk();
    }
    Ok(())
}
