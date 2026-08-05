use crate::checkpoint::ObjectState;
use crate::server::Write;
use crate::sync::conflict_resolution::resolve_update_conflict;
use crate::sync::encrypted_note::object_state;
use crate::sync::transfer::http_transport::dispatch_one_upload;
use crate::sync::transfer::{CandidateResult, UploadCandidate, UploadTarget};
use crate::sync::{decision, SyncErrorKind, SyncPhase};

use super::super::{candidate_disk_state, CandidateDiskState};
use super::{discard_tombstoned_create_and_stop, fatal_upload_error, settle_deleted_replay};
use crate::sync::push::{reason, PushContext};

pub(in crate::sync::transfer) async fn apply_replayed_create(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    write: Write,
) -> Result<Option<(String, ObjectState)>, SyncErrorKind> {
    let UploadTarget::Create(pending) = &candidate.target else {
        return Ok(Some((
            candidate.file.name.clone(),
            object_state(&write, candidate.hash.clone(), candidate.file.size),
        )));
    };
    context.state.max_version = context.state.max_version.max(write.collection_version);
    context.state.oversize_skip.remove(&candidate.file.name);

    if write.object.deleted {
        if candidate_disk_state(context.root, candidate) == CandidateDiskState::Missing {
            settle_deleted_replay(context, &candidate.file.name);
            return Ok(None);
        }
        return Err(discard_tombstoned_create_and_stop(
            context,
            &candidate.file.name,
            "replayed create resolved to a deleted object; retrying with a fresh identity",
        ));
    }

    if pending.original_name == candidate.file.name && pending.hash == candidate.hash {
        context.state.pending_creates.remove(&candidate.file.name);
        context.summary.uploaded += 1;
        context.summary.decide(
            SyncPhase::Push,
            &candidate.file.name,
            decision::UPLOADED_NEW,
            reason::NOT_ON_SERVER,
        );
        return Ok(Some((
            candidate.file.name.clone(),
            object_state(&write, pending.hash.clone(), pending.size_bytes),
        )));
    }

    apply_local_successor(context, candidate, pending, write).await
}

async fn apply_local_successor(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    pending: &crate::checkpoint::PendingCreate,
    write: Write,
) -> Result<Option<(String, ObjectState)>, SyncErrorKind> {
    let mut baseline = object_state(&write, pending.hash.clone(), pending.size_bytes);
    baseline.mtime_ms = None;
    context.state.pending_creates.remove(&candidate.file.name);

    let mut successor = candidate.clone();
    successor.target = UploadTarget::Update(baseline.clone());
    let (_, result) =
        dispatch_one_upload(context.http, &context.state.collection_id, successor).await;
    match result {
        CandidateResult::Updated(updated) if updated.object.deleted => {
            Err(discard_tombstoned_create_and_stop(
                context,
                &candidate.file.name,
                "replayed create was deleted while applying the local successor",
            ))
        }
        CandidateResult::Updated(updated) => {
            context.state.max_version = context.state.max_version.max(updated.collection_version);
            context.summary.uploaded += 1;
            context.summary.decide(
                SyncPhase::Push,
                &candidate.file.name,
                decision::UPLOADED_UPDATE,
                reason::LOCAL_CONTENT_CHANGED,
            );
            Ok(Some((
                candidate.file.name.clone(),
                object_state(&updated, candidate.hash.clone(), candidate.file.size),
            )))
        }
        CandidateResult::Conflict(conflict) => {
            if candidate_disk_state(context.root, candidate) != CandidateDiskState::Matches {
                restore_pending_create(context, candidate, pending);
                return Err(SyncErrorKind::Http(
                    "replayed create successor conflicted after the local file changed; stopping before pull"
                        .into(),
                ));
            }
            let resolved = resolve_update_conflict(
                context,
                &candidate.file,
                &baseline,
                &candidate.content,
                candidate.hash.clone(),
                conflict,
                candidate.local_was_rename,
            )
            .await;
            match resolved {
                Ok(Some(resolved)) => Ok(Some(resolved)),
                Ok(None) => {
                    restore_pending_create(context, candidate, pending);
                    Err(SyncErrorKind::Http(
                        "replayed create could not safely apply the newer local bytes".into(),
                    ))
                }
                Err(error) => {
                    restore_pending_create(context, candidate, pending);
                    Err(error)
                }
            }
        }
        CandidateResult::Failed(status_code) => {
            restore_pending_create(context, candidate, pending);
            Err(fatal_upload_error(status_code, "replayed create successor"))
        }
        CandidateResult::TooLarge => {
            restore_pending_create(context, candidate, pending);
            Err(fatal_upload_error(Some(413), "replayed create successor"))
        }
        CandidateResult::Created(_) | CandidateResult::Replayed(_) => {
            restore_pending_create(context, candidate, pending);
            Err(SyncErrorKind::Http(
                "replayed create successor returned an incompatible result".into(),
            ))
        }
    }
}

fn restore_pending_create(
    context: &mut PushContext<'_>,
    candidate: &UploadCandidate,
    pending: &crate::checkpoint::PendingCreate,
) {
    context
        .state
        .pending_creates
        .insert(candidate.file.name.clone(), pending.clone());
}
