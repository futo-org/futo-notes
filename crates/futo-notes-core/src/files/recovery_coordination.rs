//! Durable local replacement identity shared by controlled writers and recovery.
//! Callers hold `vault_mutation_guard` across observation and installation.
use std::path::Path;

use super::{collision_key, ensure_safe_note_id, note_id_from_relative_path, vault_fs};
use crate::hash::hash_sha256;

// Bootstrap's Rayon workers share a caller-owned vault guard. Alias paths
// can share a counter, so serialize the complete validated increment as well.
// Lock order: vault mutation guard -> counter mutation -> raw metadata I/O.
static COUNTER_MUTATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn stem(id: &str) -> String {
    format!(".futo-editor-recovery/{}", hash_sha256(id))
}

/// The last intentional replacement of this note. This is local metadata,
/// excluded from sync, and survives recovery-log retirement.
pub fn replacement_epoch(root: &Path, id: &str) -> Result<u64, String> {
    ensure_safe_note_id(id)?;
    let ancestors = ancestor_epoch(root, id)?;
    raw_epoch(root, &format!("{}.replacement", stem(id)))?
        .checked_add(raw_epoch(root, &collision_marker(id))?)
        .and_then(|epoch| epoch.checked_add(ancestors))
        .ok_or_else(|| "editor replacement epoch exhausted".to_owned())
}

fn ancestor_epoch(root: &Path, id: &str) -> Result<u64, String> {
    let mut epoch = 0u64;
    let mut prefix = String::new();
    let components: Vec<_> = id.split('/').collect();
    for component in &components[..components.len() - 1] {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(component);
        epoch = epoch
            .checked_add(raw_epoch(root, &directory_marker(&prefix))?)
            .ok_or_else(|| "editor replacement epoch exhausted".to_owned())?;
    }
    Ok(epoch)
}

fn raw_epoch(root: &Path, path: &str) -> Result<u64, String> {
    match vault_fs::read_optional(root, path)? {
        None => Ok(0),
        Some(bytes) => std::str::from_utf8(&bytes)
            .map_err(|error| error.to_string())?
            .parse()
            .map_err(|_| "invalid editor replacement epoch".to_owned()),
    }
}

/// Whether this id already owns a recovery stream. Callers hold the vault
/// guard when using this observation to decide a destination or installation.
pub fn has_pending_recovery(root: &Path, id: &str) -> Result<bool, String> {
    ensure_safe_note_id(id)?;
    vault_fs::exists(root, &format!("{}.jsonl", stem(id)))
}

/// Record intent durably before replacing a note with a pending recovery log,
/// including a replacement whose bytes equal an older checkpoint. A failed
/// write may conservatively park a draft; it can never undo the replacement.
/// Images and vaults that never initialized editor recovery require no metadata write.
pub fn protect_replacement(root: &Path, relative: &str) -> Result<(), String> {
    let Some(id) = note_id_from_relative_path(relative) else {
        return Ok(());
    };
    // Literal log filenames are hashes, so looking up only this spelling misses
    // a pending stream attached through a case/normalization alias. Once this
    // vault has editor recovery metadata, retain one shared collision counter.
    if !vault_fs::recovery_directory_exists(root)? {
        return Ok(());
    }
    let _counter = COUNTER_MUTATION
        .lock()
        .map_err(|_| "editor replacement counter lock poisoned".to_owned())?;
    // Retain legacy literal counters; new writes increment the shared identity
    // only, never copying the effective sum into a raw counter.
    replacement_epoch(root, &id)?
        .checked_add(1)
        .ok_or_else(|| "editor replacement epoch exhausted".to_owned())?;
    increment(root, &collision_marker(&id))
}

fn collision_marker(id: &str) -> String {
    format!("{}.collision-replacement", stem(&collision_key(id)))
}

fn directory_marker(prefix: &str) -> String {
    format!("{}.directory-replacement", stem(&collision_key(prefix)))
}

/// A directory install replaces every descendant, including entries added by an
/// external process after the caller's mapping snapshot. Never enumerate logs:
/// retain a prefix counter even when no descendant stream exists yet. Vaults
/// with no recovery directory cannot have an accepted stream and need no stamp.
pub(crate) fn protect_directory(root: &Path, prefix: &str) -> Result<(), String> {
    ensure_safe_note_id(prefix)?;
    // Under the vault guard no first append can create a stream between this
    // observation and installation. Never inspect/enumerate descendants.
    if !vault_fs::recovery_directory_exists(root)? {
        return Ok(());
    }
    let _counter = COUNTER_MUTATION
        .lock()
        .map_err(|_| "editor replacement counter lock poisoned".to_owned())?;
    ancestor_epoch(root, prefix)?
        .checked_add(raw_epoch(root, &directory_marker(prefix))?)
        .and_then(|epoch| epoch.checked_add(1))
        .ok_or_else(|| "editor replacement epoch exhausted".to_owned())?;
    increment(root, &directory_marker(prefix))
}

fn increment(root: &Path, path: &str) -> Result<(), String> {
    let next = raw_epoch(root, path)?
        .checked_add(1)
        .ok_or_else(|| "editor replacement epoch exhausted".to_owned())?;
    vault_fs::write_metadata_atomic_local(root, path, next.to_string().as_bytes())?;
    vault_fs::sync_file(root, path)?;
    vault_fs::sync_parent(root, path)?;
    vault_fs::sync_parent(root, ".futo-editor-recovery")
}
