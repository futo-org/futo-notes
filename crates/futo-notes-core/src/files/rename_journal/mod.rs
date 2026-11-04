//! The durable local rename journal (#214): its on-disk record and the view
//! sync reads to keep a renamed note's server identity. `futo-notes-store`
//! owns every move and the crash recovery that writes it; it lives here so
//! sync can read it without depending on the store (and its search index).
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

mod sync_view;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::files::{safe_note_path, vault_fs};

pub use sync_view::{
    forget_deleted_locked, set_rename_scope, with_rename_journal, IntentKey, RenameChain,
    RenameIntent, RenameJournal,
};

pub const FILE: &str = ".local-renames.json";
pub const STAGING: &str = ".local-renames";
pub const VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Prepared,
    Staged,
    Committed,
}

/// What physically moves: each note on its own, or one folder carrying them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Moves {
    Notes,
    Folder { from: String, to: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    /// Note ids (no `.md`).
    pub from: String,
    pub to: String,
    /// The server object sync bound to this move before rekeying its
    /// checkpoint. Opaque to the store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    /// The store deleted the file at `to`: the move ended there.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ended: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: u64,
    pub phase: Phase,
    pub moves: Moves,
    pub mappings: Vec<Mapping>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    /// The sync collection whose checkpoint these intents refer to. `None`
    /// while the vault has no live sync checkpoint; committed moves are then
    /// not kept, because nothing could ever bind them.
    #[serde(default)]
    pub scope: Option<String>,
    pub next_id: u64,
    #[serde(default)]
    pub transactions: Vec<Transaction>,
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

pub fn load(root: &Path) -> Result<Journal, String> {
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
        note_path(root, &mapping.from)?;
        note_path(root, &mapping.to)?;
    }
    Ok(journal)
}

pub fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    if journal.transactions.is_empty() && journal.scope.is_none() {
        return vault_fs::remove_local(root, FILE).map(|_| ());
    }
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    vault_fs::write_atomic_local(root, FILE, &bytes)
}

pub fn staged(id: u64, index: usize) -> String {
    format!("{STAGING}/{id}/{index}")
}

pub fn staged_folder(id: u64) -> String {
    format!("{STAGING}/{id}/folder")
}

pub fn remove_staging(root: &Path, id: u64) {
    let _ = vault_fs::remove_dir(root, &format!("{STAGING}/{id}"), false);
    let _ = vault_fs::remove_dir(root, STAGING, false);
}

/// A note id's vault filename.
pub fn note_filename(id: &str) -> String {
    format!("{id}.md")
}

fn note_path(root: &Path, id: &str) -> Result<(), String> {
    safe_note_path(root, id)?;
    vault_fs::validate_path(root, &note_filename(id))
}
