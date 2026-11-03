//! Durable local identity transitions. All functions with a `_locked` suffix
//! require the caller's vault mutation guard; none holds it across network I/O.
use std::path::Path;

use futo_notes_core::files::vault_fs;
use serde::{Deserialize, Serialize};

const FILE: &str = ".local-renames.json";
const WITNESSES: &str = ".local-renames";

/// A sync-owned baseline, persisted before a claimed transition can rekey its
/// checkpoint. Store treats the baseline as opaque serialized sync state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenameBinding {
    pub object_id: String,
    pub baseline: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenameMapping {
    pub from: String,
    pub to: String,
    pub binding: Option<RenameBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenameTransaction {
    pub id: u64,
    pub collection_id: Option<String>,
    pub mappings: Vec<RenameMapping>,
    committed: bool,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    next_id: u64,
    collection_id: Option<String>,
    transactions: Vec<RenameTransaction>,
}

impl Default for Journal {
    fn default() -> Self {
        Self { version: 1, next_id: 1, collection_id: None, transactions: Vec::new() }
    }
}

fn load(root: &Path) -> Result<Journal, String> {
    let Some(bytes) = vault_fs::read_optional(root, FILE)? else { return Ok(Journal::default()); };
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|error| format!("local rename journal: {error}"))?;
    if journal.version != 1 {
        return Err(format!("unsupported local rename journal version {}", journal.version));
    }
    for tx in &journal.transactions {
        for mapping in &tx.mappings {
            vault_fs::validate_path(root, &mapping.from)?;
            vault_fs::validate_path(root, &mapping.to)?;
        }
    }
    Ok(journal)
}

fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    vault_fs::write_atomic(root, FILE, &bytes)
}

fn witness(id: u64, index: usize) -> String { format!("{WITNESSES}/{id}-{index}") }

/// Persist exact allocated mappings and physical witnesses before moving a
/// source. Unsupported hard-link filesystems fail here, leaving sources intact.
pub(crate) fn prepare_locked(root: &Path, mappings: &[(String, String)]) -> Result<u64, String> {
    recover_locked(root)?;
    let mut journal = load(root)?;
    let id = journal.next_id;
    journal.next_id = id.checked_add(1).ok_or("local rename transaction IDs exhausted")?;
    let tx = RenameTransaction {
        id, collection_id: journal.collection_id.clone(), committed: false,
        mappings: mappings.iter().map(|(from, to)| RenameMapping {
            from: crate::note_filename(from), to: crate::note_filename(to), binding: None,
        }).collect(),
    };
    journal.transactions.push(tx.clone());
    save(root, &journal)?;
    for (index, mapping) in tx.mappings.iter().enumerate() {
        if !vault_fs::link_no_replace_strict(root, &mapping.from, &witness(id, index))? {
            return Err("local rename witness already exists".to_owned());
        }
    }
    Ok(id)
}

pub(crate) fn commit_locked(root: &Path, id: u64) -> Result<(), String> {
    let mut journal = load(root)?;
    let tx = journal.transactions.iter_mut().find(|tx| tx.id == id).ok_or("local rename transaction missing")?;
    tx.committed = true;
    save(root, &journal)?;
    cleanup_witnesses(root, journal.transactions.iter().find(|tx| tx.id == id).unwrap());
    Ok(())
}

fn cleanup_witnesses(root: &Path, tx: &RenameTransaction) {
    for index in 0..tx.mappings.len() {
        let _ = vault_fs::remove(root, &witness(tx.id, index));
    }
}

/// Recovery uses physical transaction witnesses, never names or body hashes.
/// An unrelated writer at either path survives. Ambiguous evidence is retained
/// and blocks further mutation/sync rather than inventing identity.
pub fn recover_locked(root: &Path) -> Result<(), String> {
    let mut journal = load(root)?;
    let mut changed = false;
    let mut aborted = Vec::new();
    for tx in &mut journal.transactions {
        if tx.committed { cleanup_witnesses(root, tx); continue; }
        let mut moved = false;
        for (index, mapping) in tx.mappings.iter().enumerate() {
            moved |= vault_fs::same_file(root, &mapping.to, &witness(tx.id, index))?;
        }
        if !moved {
            // No destination owns our witness: preparation never moved, or a
            // failed multi-file move rolled back. Every witnessed source must
            // still be ours; a missing/replaced source is ambiguous evidence.
            for (index, mapping) in tx.mappings.iter().enumerate() {
                let witness = witness(tx.id, index);
                if vault_fs::exists(root, &witness)? && !vault_fs::same_file(root, &mapping.from, &witness)? {
                    return Err("local rename recovery requires manual inspection".to_owned());
                }
            }
            aborted.push(tx.id);
            changed = true;
            continue;
        }
        for (index, mapping) in tx.mappings.iter().enumerate() {
            let witness = witness(tx.id, index);
            if vault_fs::same_file(root, &mapping.to, &witness)? { continue; }
            if !vault_fs::same_file(root, &mapping.from, &witness)? ||
                !vault_fs::move_no_replace_strict(root, &mapping.from, &mapping.to)? {
                return Err("local rename recovery destination occupied; evidence retained".to_owned());
            }
        }
        tx.committed = true;
        changed = true;
    }
    if changed {
        let cleanup = journal.transactions.iter().filter(|tx| aborted.contains(&tx.id)).cloned().collect::<Vec<_>>();
        journal.transactions.retain(|tx| !aborted.contains(&tx.id));
        save(root, &journal)?;
        for tx in cleanup { cleanup_witnesses(root, &tx); }
    }
    for tx in &journal.transactions { if tx.committed { cleanup_witnesses(root, tx); } }
    Ok(())
}

/// Change collection scope under the same guard as checkpoint reset/demotion.
/// A transition from a disconnected vault never binds to coincidental paths in
/// a newly connected collection. Markdown files remain untouched.
pub fn scope_locked(root: &Path, collection: Option<&str>) -> Result<(), String> {
    recover_locked(root)?;
    let mut journal = load(root)?;
    if journal.collection_id.as_deref() != collection {
        journal.transactions.clear();
        journal.collection_id = collection.map(str::to_owned);
        save(root, &journal)?;
    }
    Ok(())
}

pub fn pending_locked(root: &Path, collection: &str) -> Result<Vec<RenameTransaction>, String> {
    recover_locked(root)?;
    Ok(load(root)?.transactions.into_iter().filter(|tx| tx.committed && tx.collection_id.as_deref() == Some(collection)).collect())
}

pub fn bind_locked(root: &Path, id: u64, mappings: Vec<RenameMapping>) -> Result<(), String> {
    let mut journal = load(root)?;
    let tx = journal.transactions.iter_mut().find(|tx| tx.id == id).ok_or("local rename transaction missing")?;
    if tx.mappings.len() != mappings.len() || tx.mappings.iter().zip(&mappings).any(|(a,b)| a.from != b.from || a.to != b.to) {
        return Err("local rename claim changed transaction mappings".to_owned());
    }
    tx.mappings = mappings;
    save(root, &journal)
}

/// Called only after the server outcome AND the destination checkpoint are
/// durable. A replay before this point keeps the original object ID/baseline.
pub fn acknowledge_locked(root: &Path, ids: &[u64]) -> Result<(), String> {
    let mut journal = load(root)?;
    journal.transactions.retain(|tx| !ids.contains(&tx.id));
    save(root, &journal)
}

/// Newly arriving local moves must stop an in-flight cycle from writing their
/// old paths. Call inside the existing guarded filesystem decision boundary.
pub fn path_moved_locked(root: &Path, name: &str) -> Result<bool, String> {
    Ok(load(root)?.transactions.iter().any(|tx| tx.mappings.iter().any(|mapping| mapping.from == name)))
}
