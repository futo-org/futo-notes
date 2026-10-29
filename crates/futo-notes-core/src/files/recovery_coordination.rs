//! Durable local replacement identity shared by controlled writers and recovery.
//! Callers hold `vault_mutation_guard` across observation and installation.
use std::path::Path;

use super::{ensure_safe_note_id, note_id_from_relative_path, vault_fs};
use crate::hash::hash_sha256;

fn stem(id: &str) -> String {
    format!(".futo-editor-recovery/{}", hash_sha256(id))
}

/// The last intentional replacement of this note. This is local metadata,
/// excluded from sync, and survives recovery-log retirement.
pub fn replacement_epoch(root: &Path, id: &str) -> Result<u64, String> {
    ensure_safe_note_id(id)?;
    match vault_fs::read_optional(root, &format!("{}.replacement", stem(id)))? {
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
/// Images and vaults without an editor log require no metadata write.
pub fn protect_replacement(root: &Path, relative: &str) -> Result<(), String> {
    let Some(id) = note_id_from_relative_path(relative) else {
        return Ok(());
    };
    let stem = stem(&id);
    if !has_pending_recovery(root, &id)? {
        return Ok(());
    }
    let next = replacement_epoch(root, &id)?
        .checked_add(1)
        .ok_or_else(|| "editor replacement epoch exhausted".to_owned())?;
    let path = format!("{stem}.replacement");
    vault_fs::write_atomic_local(root, &path, next.to_string().as_bytes())?;
    vault_fs::sync_file(root, &path)?;
    vault_fs::sync_parent(root, &path)?;
    vault_fs::sync_parent(root, ".futo-editor-recovery")
}
