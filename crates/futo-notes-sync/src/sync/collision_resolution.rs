use std::path::Path;

use futo_notes_core::conflict_names::collision_conflict_filename;
use futo_notes_core::files::collision_key;
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{ConnectedState, ObjectState};

use super::encrypted_note::RemoteNote;
use super::outcome::note_id;
use super::{PreWrite, RenamePair, SyncSummary};

fn collision_rivals(
    state: &ConnectedState,
    remote_object_id: &str,
    requested: &str,
) -> Vec<(String, ObjectState)> {
    let key = collision_key(requested);
    state
        .object_map
        .iter()
        .filter(|(name, entry)| entry.object_id != remote_object_id && collision_key(name) == key)
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect()
}

fn remote_wins_collision(rivals: &[(String, ObjectState)], remote_object_id: &str) -> bool {
    rivals
        .iter()
        .map(|(_, entry)| entry.object_id.as_str())
        .chain(std::iter::once(remote_object_id))
        .min()
        == Some(remote_object_id)
}

struct CollisionContext<'a> {
    state: &'a mut ConnectedState,
    root: &'a Path,
    requested: &'a str,
    remote_hash: &'a str,
    pre_write: &'a PreWrite,
    summary: &'a mut SyncSummary,
}

fn move_collision_loser(
    context: &mut CollisionContext<'_>,
    name: String,
    entry: ObjectState,
) -> Result<(), String> {
    if entry.hash.as_deref() == Some(context.remote_hash) {
        context.state.object_map.remove(&name);
        return Ok(());
    }
    if !context.root.join(&name).exists() {
        return Ok(());
    }
    let target = collision_conflict_filename(context.requested, &entry.object_id);
    (context.pre_write)(&name);
    (context.pre_write)(&target);
    if let Some(parent) = context.root.join(&target).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(context.root.join(&name), context.root.join(&target))
        .map_err(|error| error.to_string())?;
    context.state.object_map.remove(&name);
    context.state.object_map.insert(target.clone(), entry);
    context.summary.local_writes_applied += 1;
    context.summary.deleted_ids.push(note_id(&name));
    // A relocation records its byproduct against the SOURCE id only: the
    // "delete at the old name" above plus the rename intent below. It must NOT
    // record an update against the target — the bytes moved unchanged, so
    // there is nothing for a shell to reload, and a synthetic target update
    // could not be told apart from a real same-cycle peer edit to the same
    // object, which combine() would then erase (see remove_rename_ghost_ids).
    // Rename intent lets shells follow the relocation (open tab/editor)
    // without inferring from id patterns.
    context.summary.renamed.push(RenamePair {
        from_id: note_id(&name),
        to_id: note_id(&target),
    });
    Ok(())
}

pub(super) fn place_collision(
    state: &mut ConnectedState,
    root: &Path,
    remote: &RemoteNote,
    requested: &str,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<Option<String>, String> {
    let rivals = collision_rivals(state, &remote.object.id, requested);
    if rivals.is_empty() {
        return Ok(Some(requested.to_owned()));
    }
    let remote_hash = hash_sha256(&remote.content);
    if !remote_wins_collision(&rivals, &remote.object.id) {
        if rivals.iter().any(|(name, entry)| {
            entry.hash.as_ref() == Some(&remote_hash) && root.join(name).exists()
        }) {
            return Ok(None);
        }
        return Ok(Some(collision_conflict_filename(
            requested,
            &remote.object.id,
        )));
    }
    let mut context = CollisionContext {
        state,
        root,
        requested,
        remote_hash: &remote_hash,
        pre_write,
        summary,
    };
    for (name, entry) in rivals {
        move_collision_loser(&mut context, name, entry)?;
    }
    Ok(Some(requested.to_owned()))
}
