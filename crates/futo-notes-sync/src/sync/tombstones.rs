use std::collections::HashMap;
use std::path::Path;

#[cfg(test)]
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futo_notes_core::conflict_names::{collision_conflict_filename, conflict_filename};
use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::is_image_filename;

use crate::checkpoint::{Ancestry, ConnectedState};
use crate::server::Object;

use super::object_map::mapped_name;
use super::outcome::note_id;
use super::vault::{conflict_date, local_files};
use super::vault_fs;
use super::{PreWrite, SyncSummary};

const CLAIM_PREFIX: &str = ".sf-tomb-";
const CLAIM_SIDECAR_SUFFIX: &str = ".path";

fn claim_names(name: &str, object_id: &str) -> (String, String) {
    let digest = hash_sha256(&format!("{object_id}\0{name}"));
    let claim = format!("{CLAIM_PREFIX}{digest}");
    let sidecar = format!("{claim}{CLAIM_SIDECAR_SUFFIX}");
    (claim, sidecar)
}

#[cfg(test)]
pub(super) fn claim_paths(root: &Path, name: &str, object_id: &str) -> (PathBuf, PathBuf) {
    let (claim, sidecar) = claim_names(name, object_id);
    (root.join(claim), root.join(sidecar))
}

fn remove_if_present(root: &Path, name: &str) -> Result<(), String> {
    vault_fs::remove(root, name).map(|_| ())
}

fn recover_stale_claim(root: &Path, name: &str, pre_write: &PreWrite) {
    let sidecar = format!("{name}{CLAIM_SIDECAR_SUFFIX}");
    let Ok(original) = vault_fs::read(root, &sidecar)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
    else {
        return;
    };
    if !matches!(
        classify_incoming_sync_path(&original),
        IncomingSyncPath::Accept
    ) {
        return;
    }
    let Ok(destination_exists) = vault_fs::exists(root, &original) else {
        return;
    };
    if destination_exists {
        let _ = remove_if_present(root, name);
        let _ = remove_if_present(root, &sidecar);
        return;
    }
    pre_write(&original);
    if matches!(vault_fs::rename(root, name, &original), Ok(true)) {
        let _ = remove_if_present(root, &sidecar);
    }
}

fn remove_orphan_sidecars(root: &Path, names: &[String]) {
    for name in names
        .iter()
        .filter(|name| name.ends_with(CLAIM_SIDECAR_SUFFIX))
    {
        let claim_name = name.trim_end_matches(CLAIM_SIDECAR_SUFFIX);
        if vault_fs::exists(root, claim_name).is_ok_and(|exists| !exists) {
            let _ = remove_if_present(root, name);
        }
    }
}

pub(super) fn recover_stale_claims(root: &Path, pre_write: &PreWrite) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(CLAIM_PREFIX))
        .collect();

    for name in names
        .iter()
        .filter(|name| !name.ends_with(CLAIM_SIDECAR_SUFFIX))
    {
        recover_stale_claim(root, name, pre_write);
    }
    remove_orphan_sidecars(root, &names);
}

fn claim_local_names(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<Option<(String, String)>, String> {
    let (claim, sidecar) = claim_names(name, object_id);
    vault_fs::write_atomic(root, &sidecar, name.as_bytes())?;
    pre_write(name);
    match vault_fs::rename(root, name, &claim) {
        Ok(true) => Ok(Some((claim, sidecar))),
        Ok(false) => {
            let _ = remove_if_present(root, &sidecar);
            Ok(None)
        }
        Err(error) => {
            // A rename error may be a directory-fsync failure after the claim
            // moved. Keep its recovery authority; the stale sweep removes the
            // sidecar if the rename truly did not happen.
            Err(error)
        }
    }
}

#[cfg(test)]
pub(super) fn claim_local(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    claim_local_names(root, name, object_id, pre_write)
        .map(|claimed| claimed.map(|(claim, sidecar)| (root.join(claim), root.join(sidecar))))
}

fn restore_claim(root: &Path, claim: &str, sidecar: &str, destination: &str) {
    if vault_fs::exists(root, destination).is_ok_and(|exists| !exists)
        && matches!(vault_fs::rename(root, claim, destination), Ok(true))
    {
        let _ = remove_if_present(root, sidecar);
    }
}

fn claim_content(root: &Path, claim: &str, original_name: &str) -> Result<String, String> {
    let bytes = vault_fs::read(root, claim)?;
    if is_image_filename(original_name) {
        Ok(BASE64.encode(bytes))
    } else {
        String::from_utf8(bytes).map_err(|error| error.to_string())
    }
}

fn tombstone_target(
    state: &ConnectedState,
    object_id: &str,
    ancestry: &HashMap<String, Ancestry>,
) -> Option<(String, String)> {
    mapped_name(state, object_id)
        .and_then(|name| {
            state
                .object_map
                .get(&name)
                .and_then(|entry| entry.hash.clone())
                .map(|hash| (name, hash))
        })
        .or_else(|| {
            ancestry
                .iter()
                .find(|(_, entry)| entry.object_id == object_id)
                .map(|(name, entry)| (name.clone(), entry.hash.clone()))
        })
}

fn park_divergent_claim(
    root: &Path,
    name: &str,
    object_id: &str,
    claim_names: (&str, &str),
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let (claim, sidecar) = claim_names;
    let names = local_files(root)?
        .into_iter()
        .map(|file| file.name)
        .collect();
    let mut copy = collision_conflict_filename(name, object_id);
    if vault_fs::exists(root, &copy)? {
        copy = conflict_filename(name, &conflict_date(), &names);
    }
    pre_write(&copy);
    match vault_fs::rename(root, claim, &copy) {
        Ok(true) => {}
        Ok(false) => {
            restore_claim(root, claim, sidecar, name);
            return Err(format!("tombstone claim disappeared: {claim}"));
        }
        Err(error) => {
            restore_claim(root, claim, sidecar, name);
            return Err(error);
        }
    }
    summary.conflicts += 1;
    summary.local_writes_applied += 1;
    summary.updated_ids.push(note_id(&copy));
    summary.peer_updated_ids.push(note_id(&copy));
    Ok(())
}

pub(super) fn apply_tombstone(
    state: &mut ConnectedState,
    root: &Path,
    object: &Object,
    ancestry: &HashMap<String, Ancestry>,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let Some((name, expected_hash)) = tombstone_target(state, &object.id, ancestry) else {
        return Ok(());
    };
    let Some((claim, sidecar)) = claim_local_names(root, &name, &object.id, pre_write)? else {
        state.object_map.remove(&name);
        return Ok(());
    };
    let current = match claim_content(root, &claim, &name) {
        Ok(content) => content,
        Err(error) => {
            restore_claim(root, &claim, &sidecar, &name);
            return Err(error);
        }
    };
    if hash_sha256(&current) == expected_hash {
        if let Err(error) = remove_if_present(root, &claim) {
            restore_claim(root, &claim, &sidecar, &name);
            return Err(error);
        }
        summary.local_writes_applied += 1;
    } else {
        park_divergent_claim(
            root,
            &name,
            &object.id,
            (&claim, &sidecar),
            pre_write,
            summary,
        )?;
    }
    remove_if_present(root, &sidecar)?;
    state.object_map.remove(&name);
    summary.deleted += 1;
    summary.deleted_ids.push(note_id(&name));
    summary.peer_deleted_ids.push(note_id(&name));
    Ok(())
}
