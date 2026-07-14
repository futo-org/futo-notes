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
        let candidates: Vec<_> = added
            .iter()
            .filter(|(_, entry)| entry.hash.as_ref() == Some(hash))
            .collect();
        let removed_with_hash = removed
            .iter()
            .filter(|(_, entry)| entry.hash.as_ref() == Some(hash))
            .count();
        if candidates.len() == 1 && removed_with_hash == 1 {
            renames.push(RenamePair {
                from_id: note_id(old_name),
                to_id: note_id(candidates[0].0),
            });
        }
    }
    renames
}

fn append_unique(target: &mut Vec<String>, source: Vec<String>) {
    for item in source {
        if !target.contains(&item) {
            target.push(item);
        }
    }
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
    for rename in pull.renamed {
        if !push
            .renamed
            .iter()
            .any(|current| current.from_id == rename.from_id && current.to_id == rename.to_id)
        {
            push.renamed.push(rename);
        }
    }
    let renamed_from: HashSet<_> = push
        .renamed
        .iter()
        .map(|rename| rename.from_id.as_str())
        .collect();
    let renamed_to: HashSet<_> = push
        .renamed
        .iter()
        .map(|rename| rename.to_id.as_str())
        .collect();
    push.updated_ids
        .retain(|id| !renamed_to.contains(id.as_str()));
    push.peer_updated_ids
        .retain(|id| !renamed_to.contains(id.as_str()));
    push.deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()) && !renamed_to.contains(id.as_str()));
    push.peer_deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()) && !renamed_to.contains(id.as_str()));
    push
}
