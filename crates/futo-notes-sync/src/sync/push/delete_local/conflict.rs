use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};

use crate::checkpoint::ObjectState;
use crate::session::connect::collection_error;
use crate::sync::encrypted_note::{decrypt, state_from_remote, RemoteNote};
use crate::sync::outcome::note_id;
use crate::sync::vault::{write_content_if_source_and_target_absent, GuardedWriteOutcome};
use crate::sync::{decision, SyncErrorKind, SyncPhase};

use super::super::{reason, PushContext};

enum DeleteConflictPlacement {
    Applied(String),
    SourceChanged,
}

fn resolved_remote_name(remote_name: &str, local_name: &str) -> String {
    match classify_incoming_sync_path(remote_name) {
        IncomingSyncPath::Accept => remote_name.to_owned(),
        IncomingSyncPath::Sanitize(name) => name,
        _ => local_name.to_owned(),
    }
}

fn write_remote_winner(
    context: &PushContext<'_>,
    name: &str,
    target: &str,
    remote: &RemoteNote,
) -> Result<DeleteConflictPlacement, SyncErrorKind> {
    let modified = state_from_remote(remote).mtime_ms.unwrap_or(0);
    let outcome = write_content_if_source_and_target_absent(
        context.root,
        name,
        target,
        &remote.content,
        modified,
        context.pre_write,
    )
    .map_err(SyncErrorKind::Io)?;
    match outcome {
        GuardedWriteOutcome::Applied => Ok(DeleteConflictPlacement::Applied(target.to_owned())),
        GuardedWriteOutcome::SourceChanged => Ok(DeleteConflictPlacement::SourceChanged),
        GuardedWriteOutcome::TargetOccupied => {
            write_remote_winner_at_source(context, name, remote, modified)
        }
    }
}

fn write_remote_winner_at_source(
    context: &PushContext<'_>,
    name: &str,
    remote: &RemoteNote,
    modified: i64,
) -> Result<DeleteConflictPlacement, SyncErrorKind> {
    let outcome = write_content_if_source_and_target_absent(
        context.root,
        name,
        name,
        &remote.content,
        modified,
        context.pre_write,
    )
    .map_err(SyncErrorKind::Io)?;
    match outcome {
        GuardedWriteOutcome::Applied => Ok(DeleteConflictPlacement::Applied(name.to_owned())),
        GuardedWriteOutcome::SourceChanged | GuardedWriteOutcome::TargetOccupied => {
            Ok(DeleteConflictPlacement::SourceChanged)
        }
    }
}

fn protect_delete_candidate(context: &mut PushContext<'_>, name: &str, entry: &ObjectState) {
    let mut protected = entry.clone();
    protected.mtime_ms = None;
    context.state.object_map.insert(name.to_owned(), protected);
    context.summary.conflicts += 1;
}

fn settle_remote_winner(
    context: &mut PushContext<'_>,
    name: &str,
    settled_name: String,
    remote: &RemoteNote,
) {
    context.state.object_map.remove(name);
    context
        .state
        .object_map
        .insert(settled_name.clone(), state_from_remote(remote));
    context.summary.downloaded += 1;
    context.summary.conflicts += 1;
    context.summary.local_writes_applied += 1;
    context
        .summary
        .peer_updated_ids
        .push(note_id(&settled_name));
    context.summary.decide_with(
        SyncPhase::Push,
        name,
        decision::DOWNLOADED,
        reason::DELETE_LOST_TO_REMOTE_EDIT,
        settled_name,
    );
}

pub(super) async fn apply_delete_conflict(
    context: &mut PushContext<'_>,
    name: &str,
    entry: &ObjectState,
) -> Result<(), SyncErrorKind> {
    let current = context
        .http
        .object(&context.state.collection_id, &entry.object_id)
        .await
        .map_err(collection_error)?;
    let Ok(remote) = decrypt(context.http, &context.state.vault_key, &current).await else {
        return Ok(());
    };
    let target = resolved_remote_name(&remote.name, name);
    match write_remote_winner(context, name, &target, &remote)? {
        DeleteConflictPlacement::Applied(settled_name) => {
            settle_remote_winner(context, name, settled_name, &remote)
        }
        DeleteConflictPlacement::SourceChanged => protect_delete_candidate(context, name, entry),
    }
    Ok(())
}
