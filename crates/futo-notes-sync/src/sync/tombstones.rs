use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futo_notes_core::e2ee::{collision_conflict_filename, conflict_filename};
use futo_notes_core::files::{
    classify_incoming_sync_path, read_blob_as_base64, write_atomic_text, IncomingSyncPath,
};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::is_image_filename;

use crate::checkpoint::{Ancestry, ConnectedState};
use crate::server::Object;

use super::object_map::mapped_name;
use super::outcome::note_id;
use super::vault::{conflict_date, local_files};
use super::{PreWrite, SyncSummary};

const CLAIM_PREFIX: &str = ".sf-tomb-";
const CLAIM_SIDECAR_SUFFIX: &str = ".path";

pub(super) fn claim_paths(root: &Path, name: &str, object_id: &str) -> (PathBuf, PathBuf) {
    let digest = hash_sha256(&format!("{object_id}\0{name}"));
    let claim = root.join(format!("{CLAIM_PREFIX}{digest}"));
    let sidecar = root.join(format!("{CLAIM_PREFIX}{digest}{CLAIM_SIDECAR_SUFFIX}"));
    (claim, sidecar)
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
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
        let claim = root.join(name);
        let sidecar = root.join(format!("{name}{CLAIM_SIDECAR_SUFFIX}"));
        let Ok(original) = std::fs::read_to_string(&sidecar) else {
            continue;
        };
        if !matches!(
            classify_incoming_sync_path(&original),
            IncomingSyncPath::Accept
        ) {
            continue;
        }
        let destination = root.join(&original);
        if destination.exists() {
            let _ = remove_if_present(&claim);
            let _ = remove_if_present(&sidecar);
            continue;
        }
        if let Some(parent) = destination.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        pre_write(&original);
        if std::fs::rename(&claim, &destination).is_ok() {
            let _ = remove_if_present(&sidecar);
        }
    }

    for name in names
        .iter()
        .filter(|name| name.ends_with(CLAIM_SIDECAR_SUFFIX))
    {
        let claim_name = name.trim_end_matches(CLAIM_SIDECAR_SUFFIX);
        if !root.join(claim_name).exists() {
            let _ = remove_if_present(&root.join(name));
        }
    }
}

pub(super) fn claim_local(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let (claim, sidecar) = claim_paths(root, name, object_id);
    write_atomic_text(&sidecar, name)?;
    pre_write(name);
    match std::fs::rename(root.join(name), &claim) {
        Ok(()) => Ok(Some((claim, sidecar))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let _ = remove_if_present(&sidecar);
            Ok(None)
        }
        Err(error) => {
            let _ = remove_if_present(&sidecar);
            Err(error.to_string())
        }
    }
}

fn restore_claim(claim: &Path, sidecar: &Path, destination: &Path) {
    if !destination.exists() {
        if let Some(parent) = destination.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(claim, destination).is_ok() {
            let _ = remove_if_present(sidecar);
        }
    }
}

fn claim_content(claim: &Path, original_name: &str) -> Result<String, String> {
    if is_image_filename(original_name) {
        read_blob_as_base64(claim)
    } else {
        std::fs::read_to_string(claim).map_err(|error| error.to_string())
    }
}

pub(super) fn apply_tombstone(
    state: &mut ConnectedState,
    root: &Path,
    object: &Object,
    ancestry: &HashMap<String, Ancestry>,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let mapped = mapped_name(state, &object.id);
    let ancestral = ancestry
        .iter()
        .find(|(_, entry)| entry.object_id == object.id)
        .map(|(name, entry)| (name.clone(), entry.clone()));
    let Some((name, expected_hash)) = mapped
        .and_then(|name| {
            state
                .object_map
                .get(&name)
                .and_then(|entry| entry.hash.clone())
                .map(|hash| (name, hash))
        })
        .or_else(|| ancestral.map(|(name, entry)| (name, entry.hash)))
    else {
        return Ok(());
    };
    let Some((claim, sidecar)) = claim_local(root, &name, &object.id, pre_write)? else {
        state.object_map.remove(&name);
        return Ok(());
    };
    let current = match claim_content(&claim, &name) {
        Ok(content) => content,
        Err(error) => {
            restore_claim(&claim, &sidecar, &root.join(&name));
            return Err(error);
        }
    };
    if hash_sha256(&current) == expected_hash {
        if let Err(error) = remove_if_present(&claim) {
            restore_claim(&claim, &sidecar, &root.join(&name));
            return Err(error);
        }
        summary.local_writes_applied += 1;
    } else {
        let names = local_files(root)
            .into_iter()
            .map(|file| file.name)
            .collect();
        let mut copy = collision_conflict_filename(&name, &object.id);
        if root.join(&copy).exists() {
            copy = conflict_filename(&name, &conflict_date(), &names);
        }
        pre_write(&copy);
        if let Some(parent) = root.join(&copy).parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if let Err(error) = std::fs::rename(&claim, root.join(&copy)) {
            restore_claim(&claim, &sidecar, &root.join(&name));
            return Err(error.to_string());
        }
        summary.conflicts += 1;
        summary.local_writes_applied += 1;
        summary.updated_ids.push(note_id(&copy));
        summary.peer_updated_ids.push(note_id(&copy));
    }
    remove_if_present(&sidecar)?;
    state.object_map.remove(&name);
    summary.deleted += 1;
    summary.deleted_ids.push(note_id(&name));
    summary.peer_deleted_ids.push(note_id(&name));
    Ok(())
}
