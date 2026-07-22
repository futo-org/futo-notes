use std::collections::{HashMap, HashSet};

use crate::checkpoint::ObjectState;

pub type Progress = dyn Fn(SyncProgress) + Send + Sync;
pub type PreWrite = dyn Fn(&str) + Send + Sync;

#[derive(Debug, Clone)]
pub struct ConnectInfo {
    pub user_id: String,
    pub collection_id: String,
    pub token: String,
    pub auth_mode: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SyncProgress {
    pub phase: &'static str,
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Upload,
    Delete,
    Checkpoint,
    Download,
    Decrypt,
    Rejected,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Delete => "delete",
            Self::Checkpoint => "checkpoint",
            Self::Download => "download",
            Self::Decrypt => "decrypt",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: FailureKind,
    pub status_code: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct RenamePair {
    pub from_id: String,
    pub to_id: String,
}

#[derive(Debug, Default, Clone)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    pub local_writes_applied: u32,
    pub failures: Vec<SyncFailure>,
    pub updated_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
    pub peer_updated_ids: Vec<String>,
    pub peer_deleted_ids: Vec<String>,
    pub renamed: Vec<RenamePair>,
}

impl SyncSummary {
    pub fn failure_message(&self) -> Option<String> {
        let server: Vec<_> = self
            .failures
            .iter()
            .filter(|failure| matches!(failure.kind, FailureKind::Upload | FailureKind::Delete))
            .collect();
        let count = |kind| {
            self.failures
                .iter()
                .filter(|failure| failure.kind == kind)
                .count()
        };
        let mut parts = Vec::new();
        if !server.is_empty() {
            let noun = if server.len() == 1 {
                "change"
            } else {
                "changes"
            };
            let mut message = format!("{} {noun} couldn't reach the server", server.len());
            let mut frequencies = Vec::<(u16, usize)>::new();
            for status in server.iter().filter_map(|failure| failure.status_code) {
                if let Some((_, count)) = frequencies.iter_mut().find(|(code, _)| *code == status) {
                    *count += 1;
                } else {
                    frequencies.push((status, 1));
                }
            }
            let status = frequencies
                .into_iter()
                .enumerate()
                .max_by_key(|(index, (_, count))| (*count, std::cmp::Reverse(*index)))
                .map(|(_, (status, _))| status);
            if let Some(status) = status {
                message.push_str(&format!(" (HTTP {status})"));
            }
            parts.push(message);
        }
        for (kind, singular, plural) in [
            (
                FailureKind::Download,
                "note couldn't be downloaded (will retry)",
                "notes couldn't be downloaded (will retry)",
            ),
            (
                FailureKind::Decrypt,
                "note couldn't be decrypted",
                "notes couldn't be decrypted",
            ),
            (
                FailureKind::Rejected,
                "note had an unsupported name and was skipped",
                "notes had unsupported names and were skipped",
            ),
        ] {
            let count = count(kind);
            if count > 0 {
                parts.push(format!(
                    "{count} {}",
                    if count == 1 { singular } else { plural }
                ));
            }
        }
        if count(FailureKind::Checkpoint) > 0 {
            parts.push("sync state couldn't be saved locally".into());
        }
        (!parts.is_empty()).then(|| parts.join("; "))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SyncErrorKind {
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    Crypto(String),
    #[error("{0}")]
    Io(String),
    #[error("collection-gone: {0}")]
    CollectionGone(String),
    #[error("not connected")]
    NotConnected,
}

impl SyncErrorKind {
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<SyncErrorKind> for String {
    fn from(error: SyncErrorKind) -> Self {
        error.to_string()
    }
}

pub(super) fn note_id(name: &str) -> String {
    name.strip_suffix(".md").unwrap_or(name).to_owned()
}

fn unique_rename_target<'a>(
    hash: &str,
    removed: &[(&String, &ObjectState)],
    added: &'a [(&String, &ObjectState)],
) -> Option<&'a str> {
    if removed
        .iter()
        .filter(|(_, entry)| entry.hash.as_deref() == Some(hash))
        .count()
        != 1
    {
        return None;
    }
    let mut candidates = added
        .iter()
        .filter(|(_, entry)| entry.hash.as_deref() == Some(hash));
    let (name, _) = *candidates.next()?;
    candidates.next().is_none().then_some(name.as_str())
}

pub(super) fn derive_renames(
    before: &HashMap<String, ObjectState>,
    after: &HashMap<String, ObjectState>,
) -> Vec<RenamePair> {
    let removed: Vec<_> = before
        .iter()
        .filter(|(name, _)| !after.contains_key(*name))
        .collect();
    let added: Vec<_> = after
        .iter()
        .filter(|(name, _)| !before.contains_key(*name))
        .collect();
    let mut renames = Vec::new();
    for (old_name, old) in &removed {
        let Some(hash) = old.hash.as_ref() else {
            continue;
        };
        if let Some(new_name) = unique_rename_target(hash, &removed, &added) {
            renames.push(RenamePair {
                from_id: note_id(old_name),
                to_id: note_id(new_name),
            });
        }
    }
    renames
}

fn append_unique_renames(target: &mut Vec<RenamePair>, source: Vec<RenamePair>) {
    for rename in source {
        if !target
            .iter()
            .any(|existing| existing.from_id == rename.from_id && existing.to_id == rename.to_id)
        {
            target.push(rename);
        }
    }
}

pub(super) fn append_derived_renames(
    summary: &mut SyncSummary,
    before: &HashMap<String, ObjectState>,
    after: &HashMap<String, ObjectState>,
) {
    append_unique_renames(&mut summary.renamed, derive_renames(before, after));
}

fn append_unique(target: &mut Vec<String>, source: Vec<String>) {
    for item in source {
        if !target.contains(&item) {
            target.push(item);
        }
    }
}

fn remove_rename_ghost_ids(summary: &mut SyncSummary) {
    let renamed_from: HashSet<_> = summary
        .renamed
        .iter()
        .map(|rename| rename.from_id.as_str())
        .collect();
    // Only the from-side of a rename is a ghost: every relocation records its
    // "delete at the old name" byproduct against the source id and describes
    // the move itself with the rename pair. Nothing records a byproduct
    // against the TARGET side, so an id recorded there — an update OR a
    // deletion — is always a real, subsequent event: a same-cycle peer edit to
    // a collision-relocated note (which the shell that followed the rename must
    // reload, or its next save overwrites the peer edit) or a same-cycle
    // tombstone of it (which must close the followed editor). Stripping the
    // target side erased both. Strip the from-side ghost only.
    summary
        .deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()));
    summary
        .peer_deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()));
}

pub(super) fn combine(mut push: SyncSummary, pull: SyncSummary) -> SyncSummary {
    push.uploaded += pull.uploaded;
    push.downloaded += pull.downloaded;
    push.deleted += pull.deleted;
    push.conflicts += pull.conflicts;
    push.local_writes_applied += pull.local_writes_applied;
    push.failures.extend(pull.failures);
    append_unique(&mut push.updated_ids, pull.updated_ids);
    append_unique(&mut push.deleted_ids, pull.deleted_ids);
    append_unique(&mut push.peer_updated_ids, pull.peer_updated_ids);
    append_unique(&mut push.peer_deleted_ids, pull.peer_deleted_ids);
    append_unique_renames(&mut push.renamed, pull.renamed);
    remove_rename_ghost_ids(&mut push);
    push
}
