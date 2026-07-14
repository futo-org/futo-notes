use std::path::Path;

use futo_notes_core::e2ee::{collision_conflict_filename, collision_key};
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::ConnectedState;

use super::encrypted_note::RemoteNote;
use super::outcome::note_id;
use super::{PreWrite, SyncSummary};

pub(super) fn place_collision(
    state: &mut ConnectedState,
    root: &Path,
    remote: &RemoteNote,
    requested: &str,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<Option<String>, String> {
    let key = collision_key(requested);
    let rivals: Vec<_> = state
        .object_map
        .iter()
        .filter(|(name, entry)| entry.object_id != remote.object.id && collision_key(name) == key)
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect();
    if rivals.is_empty() {
        return Ok(Some(requested.to_owned()));
    }
    let remote_hash = hash_sha256(&remote.content);
    let winner = rivals
        .iter()
        .map(|(_, entry)| entry.object_id.as_str())
        .chain(std::iter::once(remote.object.id.as_str()))
        .min()
        .unwrap_or(remote.object.id.as_str());
    if winner != remote.object.id {
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
    for (name, entry) in rivals {
        if entry.hash.as_ref() == Some(&remote_hash) {
            state.object_map.remove(&name);
            continue;
        }
        if root.join(&name).exists() {
            let target = collision_conflict_filename(requested, &entry.object_id);
            pre_write(&name);
            pre_write(&target);
            if let Some(parent) = root.join(&target).parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::rename(root.join(&name), root.join(&target))
                .map_err(|error| error.to_string())?;
            state.object_map.remove(&name);
            state.object_map.insert(target.clone(), entry);
            summary.local_writes_applied += 1;
            summary.deleted_ids.push(note_id(&name));
            summary.updated_ids.push(note_id(&target));
        }
    }
    Ok(Some(requested.to_owned()))
}
