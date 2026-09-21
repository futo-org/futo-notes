use crate::checkpoint::ObjectState;
use crate::sync::encrypted_note::{encrypt, object_state};
use crate::sync::push::PushContext;
use crate::sync::transfer::http_transport::dispatch_one_upload;
use crate::sync::transfer::{CandidateResult, UploadCandidate, UploadTarget};
use crate::sync::{decision, FailureKind, SyncErrorKind, SyncFailure, SyncPhase};

use super::super::{candidate_disk_state, CandidateDiskState};
use super::{
    discard_tombstoned_create_and_stop, fatal_upload_error, fresh_pending_create,
    settle_deleted_replay, Upload,
};
use crate::sync::push::{reason, status_detail};

enum CreateDispatch {
    Written {
        write: crate::server::Write,
        replayed: bool,
    },
    SettledWithoutWrite,
}

fn apply_create_dispatch(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    result: CandidateResult,
) -> CreateDispatch {
    match result {
        CandidateResult::Created(write) => CreateDispatch::Written {
            write,
            replayed: false,
        },
        CandidateResult::Replayed(write) => CreateDispatch::Written {
            write,
            replayed: true,
        },
        CandidateResult::TooLarge => {
            context.state.pending_creates.remove(&candidate.file.name);
            context
                .state
                .oversize_skip
                .insert(candidate.file.name.clone(), candidate.file.mtime);
            context.summary.conflicts += 1;
            context.summary.decide(
                SyncPhase::Push,
                &candidate.file.name,
                decision::SKIPPED_OVERSIZE,
                reason::SERVER_REJECTED_413,
            );
            CreateDispatch::SettledWithoutWrite
        }
        CandidateResult::Failed(status_code) => {
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
            CreateDispatch::SettledWithoutWrite
        }
        CandidateResult::Conflict(_) | CandidateResult::Updated(_) => {
            context.summary.failures.push(SyncFailure {
                filename: candidate.file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some("create settled as a conflict or an update".into()),
            });
            context.summary.decide(
                SyncPhase::Push,
                &candidate.file.name,
                decision::FAILED,
                reason::UPLOAD_ERROR,
            );
            CreateDispatch::SettledWithoutWrite
        }
    }
}

pub(in crate::sync) async fn create_fresh(
    context: &mut PushContext<'_>,
    upload: Upload<'_>,
) -> Result<Option<ObjectState>, SyncErrorKind> {
    let ciphertext = match encrypt(&context.state.vault_key, upload.name, upload.content) {
        Ok(ciphertext) => ciphertext,
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: upload.name.into(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error.message()),
            });
            context.summary.decide(
                SyncPhase::Push,
                upload.name,
                decision::FAILED,
                reason::ENCRYPT_ERROR,
            );
            return Ok(None);
        }
    };
    let pending = context
        .state
        .pending_creates
        .entry(upload.name.into())
        .or_insert_with(|| fresh_pending_create(upload.name, upload.hash.clone(), upload.size))
        .clone();
    (context.save_checkpoint)(context.root, context.state).map_err(SyncErrorKind::Io)?;

    let upload_reason = upload.reason;
    let candidate = upload.into_candidate(UploadTarget::Create(pending.clone()), ciphertext);
    let (candidate, result) =
        dispatch_one_upload(context.http, &context.state.collection_id, candidate).await;
    let CreateDispatch::Written { write, replayed } =
        apply_create_dispatch(context, &candidate, result)
    else {
        return Ok(None);
    };

    context.state.max_version = context.state.max_version.max(write.collection_version);
    context.state.oversize_skip.remove(&candidate.file.name);

    if replayed && write.object.deleted {
        if candidate_disk_state(context.root, &candidate) == CandidateDiskState::Missing {
            settle_deleted_replay(context, &candidate.file.name);
            return Ok(None);
        }
        return Err(discard_tombstoned_create_and_stop(
            context,
            &candidate.file.name,
            "replayed create resolved to a deleted object; retrying with a fresh identity",
        ));
    }

    context.summary.uploaded += 1;
    if replayed && (pending.original_name != candidate.file.name || pending.hash != candidate.hash)
    {
        return apply_replayed_successor(context, candidate, pending, write).await;
    }

    context.state.pending_creates.remove(&candidate.file.name);
    context.summary.decide(
        SyncPhase::Push,
        &candidate.file.name,
        decision::UPLOADED_NEW,
        upload_reason,
    );
    if replayed {
        Ok(Some(object_state(&write, pending.hash, pending.size_bytes)))
    } else {
        Ok(Some(object_state(
            &write,
            candidate.hash,
            candidate.file.size,
        )))
    }
}

async fn apply_replayed_successor(
    context: &mut PushContext<'_>,
    mut candidate: UploadCandidate,
    pending: crate::checkpoint::PendingCreate,
    write: crate::server::Write,
) -> Result<Option<ObjectState>, SyncErrorKind> {
    candidate.target = UploadTarget::Update(object_state(&write, pending.hash, pending.size_bytes));
    let (candidate, result) =
        dispatch_one_upload(context.http, &context.state.collection_id, candidate).await;
    match result {
        CandidateResult::Updated(updated) if !updated.object.deleted => {
            context.state.pending_creates.remove(&candidate.file.name);
            context.state.max_version = context.state.max_version.max(updated.collection_version);
            context.summary.decide(
                SyncPhase::Push,
                &candidate.file.name,
                decision::UPLOADED_UPDATE,
                reason::LOCAL_CONTENT_CHANGED,
            );
            Ok(Some(object_state(
                &updated,
                candidate.hash,
                candidate.file.size,
            )))
        }
        CandidateResult::Updated(_) => Err(discard_tombstoned_create_and_stop(
            context,
            &candidate.file.name,
            "replayed create was deleted while applying the local successor",
        )),
        CandidateResult::Failed(status_code) => {
            Err(fatal_upload_error(status_code, "replayed create successor"))
        }
        CandidateResult::TooLarge => {
            Err(fatal_upload_error(Some(413), "replayed create successor"))
        }
        CandidateResult::Conflict(_)
        | CandidateResult::Created(_)
        | CandidateResult::Replayed(_) => Err(SyncErrorKind::Http(
            "replayed create could not safely apply the newer local bytes".into(),
        )),
    }
}
