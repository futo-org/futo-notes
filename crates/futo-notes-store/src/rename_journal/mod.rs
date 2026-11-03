//! The durable local rename journal (#214): what sync needs to keep a renamed
//! note's server identity, and the crash recovery that makes the record exact.
//!
//! A journaled move goes `from` -> `.local-renames/<tx>/<n>` -> `to`. The
//! staging directory belongs to one transaction, so whatever is in it is that
//! transaction's source: recovery needs neither hard links nor inode numbers,
//! never compares content, and a case- or normalization-only rename is as
//! unambiguous as any other. The phases:
//!
//! - `Prepared`: written before the first source moves. Recovery returns every
//!   staged entry to its source (or a fresh name beside it if a newcomer took
//!   it). The caller never reported success.
//! - `Staged`: written once every source sits in staging. Recovery finishes the
//!   move (a newcomer at the destination pushes ours to a fresh name), replays
//!   the backlink rewrite, and commits.
//! - `Committed`: the move and its rewrite are done. Kept for sync only while
//!   the journal has a collection scope.
//!
//! Older binaries do not read this file. Downgrading while an intent is pending
//! loses that intent's identity, and an interrupted move stays parked in the
//! hidden staging directory until a current binary recovers it. A version this
//! binary does not know is never rewritten or discarded: renames and sync stop
//! with an error and the file is left as evidence.

mod moves;
mod recovery;
mod sync_view;
#[cfg(test)]
pub(crate) mod tests_support;

use std::path::Path;

use futo_notes_core::files::vault_fs;
use serde::{Deserialize, Serialize};

pub(crate) use moves::{commit, move_journaled, JournaledMove};
pub(crate) use recovery::{commit_recovered, recover};
pub use sync_view::{set_rename_scope, with_rename_journal, RenameIntent, RenameJournal};

const FILE: &str = ".local-renames.json";
pub(super) const STAGING: &str = ".local-renames";
pub(super) const VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Prepared,
    Staged,
    Committed,
}

/// What physically moves: each note on its own, or one folder carrying them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(super) enum Moves {
    Notes,
    Folder { from: String, to: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Mapping {
    /// Note ids (no `.md`).
    pub(super) from: String,
    pub(super) to: String,
    /// The server object sync bound to this move before rekeying its
    /// checkpoint. Opaque to the store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) object_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Transaction {
    pub(super) id: u64,
    pub(super) phase: Phase,
    pub(super) moves: Moves,
    pub(super) mappings: Vec<Mapping>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Journal {
    pub(super) version: u32,
    /// The sync collection whose checkpoint these intents refer to. `None`
    /// while the vault has no live sync checkpoint; committed moves are then
    /// not kept, because nothing could ever bind them.
    #[serde(default)]
    pub(super) scope: Option<String>,
    pub(super) next_id: u64,
    #[serde(default)]
    pub(super) transactions: Vec<Transaction>,
}

impl Default for Journal {
    fn default() -> Self {
        Self {
            version: VERSION,
            scope: None,
            next_id: 1,
            transactions: Vec::new(),
        }
    }
}

pub(super) fn load(root: &Path) -> Result<Journal, String> {
    let Some(bytes) = vault_fs::read_optional(root, FILE)? else {
        return Ok(Journal::default());
    };
    let version = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("version").and_then(serde_json::Value::as_u64));
    if version != Some(u64::from(VERSION)) {
        return Err(format!(
            "the local rename journal {FILE} has an unsupported format{}; it was left untouched",
            version
                .map(|v| format!(" (version {v})"))
                .unwrap_or_default()
        ));
    }
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("the local rename journal {FILE} is unreadable: {error}"))?;
    for mapping in journal.transactions.iter().flat_map(|tx| &tx.mappings) {
        crate::paths::note_path(root, &mapping.from)?;
        crate::paths::note_path(root, &mapping.to)?;
    }
    Ok(journal)
}

pub(super) fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    if journal.transactions.is_empty() && journal.scope.is_none() {
        return vault_fs::remove_local(root, FILE).map(|_| ());
    }
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    vault_fs::write_atomic_local(root, FILE, &bytes)
}

pub(super) fn staged(id: u64, index: usize) -> String {
    format!("{STAGING}/{id}/{index}")
}

pub(super) fn staged_folder(id: u64) -> String {
    format!("{STAGING}/{id}/folder")
}

pub(super) fn remove_staging(root: &Path, id: u64) {
    let _ = vault_fs::remove_dir(root, &format!("{STAGING}/{id}"), false);
    let _ = vault_fs::remove_dir(root, STAGING, false);
}
