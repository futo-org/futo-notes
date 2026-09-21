use std::collections::{HashMap, HashSet};
use std::path::Path;

use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{ConnectedState, ObjectState, PendingCreate};
use crate::sync::encrypted_note::encrypt;
use crate::sync::outcome::note_id;
use crate::sync::transfer::{UploadCandidate, UploadTarget};
use crate::sync::vault::{read_content, LocalFile};
use crate::sync::vault_fs;
use crate::sync::{decision, FailureKind, RenamePair, SyncFailure, SyncPhase, SyncSummary};

use super::{reason, PushContext};

pub(super) fn missing_local_files(
    state: &ConnectedState,
    files: &[LocalFile],
) -> Vec<(String, ObjectState)> {
    let local_names: HashSet<_> = files.iter().map(|file| file.name.as_str()).collect();
    state
        .object_map
        .iter()
        .filter(|(name, _)| !local_names.contains(name.as_str()))
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect()
}

fn unique_rename_candidate<'a>(
    missing: &'a [(String, ObjectState)],
    claimed_missing: &HashSet<String>,
    basename: &str,
    hash: &str,
) -> Option<&'a (String, ObjectState)> {
    let mut candidates = missing.iter().filter(|(old, entry)| {
        !claimed_missing.contains(old)
            && entry.hash.as_deref() == Some(hash)
            && old.rsplit('/').next().unwrap_or(old) == basename
    });
    let candidate = candidates.next()?;
    candidates.next().is_none().then_some(candidate)
}

pub(super) fn detect_local_renames(
    state: &mut ConnectedState,
    root: &Path,
    files: &[LocalFile],
    missing: &[(String, ObjectState)],
    summary: &mut SyncSummary,
) -> Result<(HashSet<String>, HashSet<String>), String> {
    let unmapped: Vec<_> = files
        .iter()
        .filter(|file| !state.object_map.contains_key(&file.name))
        .filter(|file| !state.pending_creates.contains_key(&file.name))
        .collect();
    let mut hashes = HashMap::new();
    for file in &unmapped {
        let content = read_content(root, &file.name)?;
        hashes.insert(file.name.as_str(), hash_sha256(&content));
    }
    let mut claimed_missing = HashSet::new();
    let mut renamed_files = HashSet::new();

    for file in unmapped {
        let Some(hash) = hashes.get(file.name.as_str()) else {
            continue;
        };
        let basename = file.name.rsplit('/').next().unwrap_or(&file.name);
        let Some((old, entry)) = unique_rename_candidate(missing, &claimed_missing, basename, hash)
        else {
            continue;
        };

        state.object_map.remove(old);
        state.object_map.insert(file.name.clone(), entry.clone());
        claimed_missing.insert(old.clone());
        renamed_files.insert(file.name.clone());
        summary.decide_with(
            SyncPhase::Push,
            old,
            decision::RENAME_DETECTED,
            reason::SAME_HASH_AND_BASENAME,
            file.name.clone(),
        );
        summary.renamed.push(RenamePair {
            from_id: note_id(old),
            to_id: note_id(&file.name),
        });
    }

    Ok((claimed_missing, renamed_files))
}

fn reuse_unchanged_object(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    hash: &str,
    renamed: bool,
) -> bool {
    if renamed || existing.hash.as_deref() != Some(hash) {
        return false;
    }
    if let Some(server_mtime) = existing.mtime_ms {
        if server_mtime != file.mtime {
            (context.pre_write)(&file.name);
            let _ = vault_fs::set_mtime_ms(context.root, &file.name, server_mtime);
        }
    }
    let mut entry = existing.clone();
    entry.size_bytes = Some(file.size);
    context.state.object_map.insert(file.name.clone(), entry);
    true
}

pub(in crate::sync) fn prepare_upload(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    renamed: bool,
) -> Option<UploadCandidate> {
    if context.state.oversize_skip.get(&file.name) == Some(&file.mtime) {
        context.summary.conflicts += 1;
        context.summary.decide(
            SyncPhase::Push,
            &file.name,
            decision::SKIPPED_OVERSIZE,
            reason::UNCHANGED_SINCE_413,
        );
        return None;
    }
    let existing = context.state.object_map.get(&file.name).cloned();
    if !renamed
        && existing.as_ref().is_some_and(|entry| {
            entry.mtime_ms == Some(file.mtime) && entry.size_bytes == Some(file.size)
        })
    {
        return None;
    }
    let content = match read_content(context.root, &file.name) {
        Ok(content) => content,
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error),
            });
            context.summary.decide(
                SyncPhase::Push,
                &file.name,
                decision::FAILED,
                reason::READ_ERROR,
            );
            return None;
        }
    };
    let hash = hash_sha256(&content);
    if existing
        .as_ref()
        .is_some_and(|entry| reuse_unchanged_object(context, file, entry, &hash, renamed))
    {
        return None;
    }
    let ciphertext = match encrypt(&context.state.vault_key, &file.name, &content) {
        Ok(ciphertext) => ciphertext,
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error.message()),
            });
            context.summary.decide(
                SyncPhase::Push,
                &file.name,
                decision::FAILED,
                reason::ENCRYPT_ERROR,
            );
            return None;
        }
    };
    let target = match existing {
        Some(existing) => UploadTarget::Update(existing),
        None => {
            let pending = context
                .state
                .pending_creates
                .entry(file.name.clone())
                .or_insert_with(|| PendingCreate {
                    mutation_id: uuid::Uuid::now_v7().to_string(),
                    original_name: file.name.clone(),
                    hash: hash.clone(),
                    size_bytes: file.size,
                })
                .clone();
            UploadTarget::Create(pending)
        }
    };
    Some(UploadCandidate {
        file: file.clone(),
        target,
        content,
        hash,
        ciphertext,
        local_was_rename: renamed,
    })
}
