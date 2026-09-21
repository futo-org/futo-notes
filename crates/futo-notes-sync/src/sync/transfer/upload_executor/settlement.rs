use crate::checkpoint::{ConnectedState, ObjectState};
use crate::sync::conflict_resolution::resolve_update_conflict;
use crate::sync::encrypted_note::object_state;
use crate::sync::transfer::{CandidateResult, UploadCandidate, UploadTarget};
use crate::sync::vault_fs;
use crate::sync::{decision, FailureKind, SyncErrorKind, SyncFailure, SyncPhase};

use super::create_identity::{apply_replayed_create, create_fresh, Upload};
use super::{candidate_disk_state, CandidateDiskState};
use crate::sync::push::{reason, status_detail, PushContext};

fn settle_created_identity(
    state: &mut ConnectedState,
    candidate: &UploadCandidate,
    result: &CandidateResult,
) {
    if matches!(&candidate.target, UploadTarget::Create(_))
        && matches!(result, CandidateResult::Created(_))
    {
        state.pending_creates.remove(&candidate.file.name);
    }
}

fn record_upload_failure(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    status_code: Option<u16>,
) {
    context.summary.failures.push(SyncFailure {
        filename: candidate.file.name.clone(),
        kind: FailureKind::Upload,
        status_code,
        detail: Some(status_detail(status_code)),
    });
    context.summary.decide_with(
        SyncPhase::Push,
        &candidate.file.name,
        decision::FAILED,
        reason::UPLOAD_ERROR,
        status_detail(status_code),
    );
}

fn record_upload_success(context: &mut PushContext<'_>, candidate: &UploadCandidate) {
    let (action, reason) = match candidate.target {
        UploadTarget::Create(_) => (decision::UPLOADED_NEW, reason::NOT_ON_SERVER),
        UploadTarget::Update(_) => (decision::UPLOADED_UPDATE, reason::LOCAL_CONTENT_CHANGED),
    };
    context
        .summary
        .decide(SyncPhase::Push, &candidate.file.name, action, reason);
}

fn record_oversize_skip(context: &mut PushContext<'_>, candidate: &UploadCandidate) {
    context.summary.conflicts += 1;
    context.summary.decide(
        SyncPhase::Push,
        &candidate.file.name,
        decision::SKIPPED_OVERSIZE,
        reason::SERVER_REJECTED_413,
    );
}

fn keep_newer_local_edit_dirty(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    result: CandidateResult,
) {
    settle_created_identity(context.state, candidate, &result);
    if let UploadTarget::Update(mut existing) = candidate.target.clone() {
        existing.mtime_ms = None;
        context
            .state
            .object_map
            .insert(candidate.file.name.clone(), existing);
    }

    match result {
        CandidateResult::Created(write)
        | CandidateResult::Replayed(write)
        | CandidateResult::Updated(write) => {
            context.state.max_version = context.state.max_version.max(write.collection_version);
            context.state.oversize_skip.remove(&candidate.file.name);
            context.summary.uploaded += 1;
            record_upload_success(context, candidate);
            if write.object.deleted {
                context.state.object_map.remove(&candidate.file.name);
            } else {
                let mut entry = object_state(&write, candidate.hash.clone(), candidate.file.size);
                entry.mtime_ms = None;
                context
                    .state
                    .object_map
                    .insert(candidate.file.name.clone(), entry);
            }
        }
        CandidateResult::Conflict(_) => record_upload_failure(context, candidate, Some(409)),
        CandidateResult::TooLarge => record_oversize_skip(context, candidate),
        CandidateResult::Failed(status_code) => {
            record_upload_failure(context, candidate, status_code)
        }
    }
}

async fn apply_current_candidate(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    result: CandidateResult,
) -> Result<Option<(String, ObjectState)>, SyncErrorKind> {
    match result {
        CandidateResult::Created(write) | CandidateResult::Updated(write)
            if write.object.deleted =>
        {
            create_fresh(
                context,
                Upload {
                    name: &candidate.file.name,
                    content: &candidate.content,
                    hash: candidate.hash.clone(),
                    size: candidate.file.size,
                    mtime: candidate.file.mtime,
                    reason: reason::REMOTE_OBJECT_DELETED,
                },
            )
            .await
            .map(|entry| entry.map(|entry| (candidate.file.name.clone(), entry)))
        }
        CandidateResult::Replayed(write) => apply_replayed_create(context, candidate, write).await,
        CandidateResult::Created(write) | CandidateResult::Updated(write) => {
            context.state.max_version = context.state.max_version.max(write.collection_version);
            context.state.oversize_skip.remove(&candidate.file.name);
            context.summary.uploaded += 1;
            record_upload_success(context, candidate);
            Ok(Some((
                candidate.file.name.clone(),
                object_state(&write, candidate.hash.clone(), candidate.file.size),
            )))
        }
        CandidateResult::Conflict(conflict) => {
            let UploadTarget::Update(existing) = &candidate.target else {
                record_upload_failure(context, candidate, Some(409));
                return Ok(None);
            };
            resolve_update_conflict(
                context,
                &candidate.file,
                existing,
                &candidate.content,
                candidate.hash.clone(),
                conflict,
                candidate.local_was_rename,
            )
            .await
        }
        CandidateResult::TooLarge => {
            context
                .state
                .oversize_skip
                .insert(candidate.file.name.clone(), candidate.file.mtime);
            record_oversize_skip(context, candidate);
            Ok(None)
        }
        CandidateResult::Failed(status_code) => {
            record_upload_failure(context, candidate, status_code);
            Ok(None)
        }
    }
}

fn install_applied_candidate(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    applied: Option<(String, ObjectState)>,
) {
    let Some((target, mut entry)) = applied else {
        return;
    };
    let newer_local_edit = target == candidate.file.name
        && candidate_disk_state(context.root, candidate) != CandidateDiskState::Matches;
    if newer_local_edit {
        entry.mtime_ms = None;
    } else if let Some(modified) = entry.mtime_ms {
        (context.pre_write)(&target);
        let _ = vault_fs::set_mtime_ms(context.root, &target, modified);
    }
    if target != candidate.file.name {
        context.state.object_map.remove(&candidate.file.name);
    }
    context.state.object_map.insert(target, entry);
}

pub(in crate::sync) async fn apply_candidate(
    context: &mut PushContext<'_>,
    candidate: UploadCandidate,
    result: CandidateResult,
) -> Result<(), SyncErrorKind> {
    if let CandidateResult::Replayed(write) = result {
        let applied = apply_replayed_create(context, &candidate, write).await?;
        install_applied_candidate(context, &candidate, applied);
        return Ok(());
    }
    if candidate_disk_state(context.root, &candidate) != CandidateDiskState::Matches {
        keep_newer_local_edit_dirty(context, &candidate, result);
        return Ok(());
    }

    settle_created_identity(context.state, &candidate, &result);
    let applied = apply_current_candidate(context, &candidate, result).await?;
    install_applied_candidate(context, &candidate, applied);
    Ok(())
}
