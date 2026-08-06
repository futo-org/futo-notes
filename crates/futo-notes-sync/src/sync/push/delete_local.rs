use std::collections::HashSet;

use futo_notes_core::image::is_syncable_filename;

use crate::checkpoint::ObjectState;
use crate::server::Mutation;
use crate::sync::outcome::note_id;
use crate::sync::{decision, FailureKind, SyncErrorKind, SyncFailure, SyncPhase};

use super::{reason, status_detail, PushContext};

mod conflict;

use conflict::apply_delete_conflict;

const LEGACY_REPLAY_CREATE_VERSION: u64 = 1;

async fn hydrate_legacy_replay_entry(
    context: &mut PushContext<'_>,
    name: &str,
    entry: ObjectState,
) -> Option<ObjectState> {
    if entry.version != 0 {
        return Some(entry);
    }
    match context
        .http
        .object(&context.state.collection_id, &entry.object_id)
        .await
    {
        Ok(object) if object.deleted => {
            context.state.max_version = context.state.max_version.max(object.change_seq);
            context.state.object_map.remove(name);
            context.summary.deleted += 1;
            context.summary.deleted_ids.push(note_id(name));
            None
        }
        Ok(object) => {
            let hydrated = ObjectState {
                object_id: object.id,
                version: LEGACY_REPLAY_CREATE_VERSION,
                blob_key: object.blob_key.unwrap_or_default(),
                hash: entry.hash,
                mtime_ms: None,
                size_bytes: object.size_bytes.or(entry.size_bytes),
            };
            context
                .state
                .object_map
                .insert(name.to_owned(), hydrated.clone());
            Some(hydrated)
        }
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: name.to_owned(),
                kind: FailureKind::Delete,
                status_code: error.status,
            });
            None
        }
    }
}

fn eligible_deletions(
    missing: Vec<(String, ObjectState)>,
    claimed_missing: &HashSet<String>,
    context: &PushContext<'_>,
) -> Vec<(String, ObjectState)> {
    missing
        .into_iter()
        .filter(|(name, _)| !claimed_missing.contains(name))
        .filter(|(name, _)| is_syncable_filename(name))
        .filter_map(|(name, _)| {
            context
                .state
                .object_map
                .get(&name)
                .cloned()
                .map(|entry| (name, entry))
        })
        .collect()
}

pub(super) async fn delete_missing_objects(
    mut context: PushContext<'_>,
    missing: Vec<(String, ObjectState)>,
    claimed_missing: &HashSet<String>,
) -> Result<(), SyncErrorKind> {
    let deleted = eligible_deletions(missing, claimed_missing, &context);

    for (name, entry) in deleted {
        let Some(entry) = hydrate_legacy_replay_entry(&mut context, &name, entry).await else {
            continue;
        };
        match context
            .http
            .delete_object(
                &context.state.collection_id,
                &entry.object_id,
                entry.version,
            )
            .await
        {
            Ok(Mutation::Written(write)) => {
                context.state.max_version = context.state.max_version.max(write.collection_version);
                context.state.object_map.remove(&name);
                context.summary.deleted += 1;
                context.summary.deleted_ids.push(note_id(&name));
                context.summary.decide(
                    SyncPhase::Push,
                    &name,
                    decision::DELETED_REMOTE,
                    reason::LOCAL_FILE_GONE,
                );
            }
            Ok(Mutation::Conflict(_)) => {
                apply_delete_conflict(&mut context, &name, &entry).await?;
            }
            Err(error) => {
                context.summary.failures.push(SyncFailure {
                    filename: name.clone(),
                    kind: FailureKind::Delete,
                    status_code: error.status,
                });
                context.summary.decide_with(
                    SyncPhase::Push,
                    &name,
                    decision::FAILED,
                    reason::DELETE_ERROR,
                    status_detail(error.status),
                );
            }
        }
    }
    Ok(())
}
