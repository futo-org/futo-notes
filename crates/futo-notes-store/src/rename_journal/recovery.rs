//! Finishing or undoing transactions a crash or failure left behind.

use std::path::Path;

use futo_notes_core::files::vault_fs;

use super::moves::{commit_in, move_entry};
use super::{
    load, remove_staging, save, staged, staged_folder, Journal, Moves, Phase, Transaction,
};

/// What recovery did, for the bootstrap warnings.
pub(crate) struct Recovered {
    /// Moves to finish: mappings (possibly re-allocated) whose backlinks still
    /// need replaying, per transaction.
    pub(crate) finished: Vec<(u64, Vec<(String, String)>)>,
    pub(crate) warnings: Vec<String>,
}

/// Finish or undo every interrupted transaction. The caller holds the vault
/// guard, replays the backlink rewrite for `finished`, then calls
/// [`commit_recovered`] for each.
pub(crate) fn recover(root: &Path) -> Result<Recovered, String> {
    let mut journal = load(root)?;
    let mut recovered = Recovered {
        finished: Vec::new(),
        warnings: Vec::new(),
    };
    let pending = journal
        .transactions
        .iter()
        .filter(|tx| tx.phase != Phase::Committed)
        .cloned()
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(recovered);
    }
    for tx in pending {
        match tx.phase {
            Phase::Prepared => {
                restore_sources(root, &tx, &mut recovered.warnings)?;
                journal.transactions.retain(|other| other.id != tx.id);
            }
            Phase::Staged => {
                let mappings =
                    place_destinations(root, &mut journal, tx.id, &mut recovered.warnings)?;
                recovered.finished.push((tx.id, mappings));
            }
            Phase::Committed => {}
        }
        remove_staging(root, tx.id);
    }
    super::moves::step("recovered")?;
    save(root, &journal)?;
    Ok(recovered)
}

pub(crate) fn commit_recovered(root: &Path, id: u64) -> Result<(), String> {
    let mut journal = load(root)?;
    commit_in(&mut journal, id);
    save(root, &journal)
}

fn staged_entries(tx: &Transaction) -> Vec<(usize, String)> {
    match &tx.moves {
        Moves::Folder { .. } => vec![(0, staged_folder(tx.id))],
        Moves::Notes => (0..tx.mappings.len())
            .map(|index| (index, staged(tx.id, index)))
            .collect(),
    }
}

/// Undo a `Prepared` transaction: everything still staged goes home. A
/// newcomer at the source keeps its name; ours takes a fresh one beside it.
pub(super) fn restore_sources(
    root: &Path,
    tx: &Transaction,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    for (index, stage) in staged_entries(tx) {
        if !vault_fs::exists(root, &stage)? {
            continue;
        }
        let (source, folder) = match &tx.moves {
            Moves::Folder { from, .. } => (from.clone(), true),
            Moves::Notes => (tx.mappings[index].from.clone(), false),
        };
        if !folder && drop_if_already_moved(root, &stage, &crate::note_filename(&source))? {
            continue;
        }
        let home = free_name(root, &source, folder)?;
        move_entry(root, &stage, &entry_name(&home, folder), folder)?;
        if home != source {
            warnings.push(format!(
                "an interrupted rename of {source} was undone as {home}: the name was taken"
            ));
        }
    }
    Ok(())
}

/// Finish a `Staged` transaction. A destination a newcomer took is replaced
/// by a fresh name, recorded before anything moves into it, so a crash at any
/// point resumes towards the name the journal holds. Returns the final
/// mappings.
fn place_destinations(
    root: &Path,
    journal: &mut Journal,
    id: u64,
    warnings: &mut Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    let entries = match transaction(journal, id) {
        Some(tx) => staged_entries(tx),
        None => Vec::new(),
    };
    for (index, stage) in entries {
        if !vault_fs::exists(root, &stage)? {
            continue;
        }
        let Some(tx) = transaction(journal, id) else {
            break;
        };
        let (wanted, folder) = match &tx.moves {
            Moves::Folder { to, .. } => (to.clone(), true),
            Moves::Notes => (tx.mappings[index].to.clone(), false),
        };
        if !folder && drop_if_already_moved(root, &stage, &crate::note_filename(&wanted))? {
            continue;
        }
        let destination = free_name(root, &wanted, folder)?;
        if destination != wanted {
            relocate(journal, id, index, &wanted, &destination);
            save(root, journal)?;
            warnings.push(if folder {
                format!("an interrupted folder move finished as {destination}: {wanted} was taken")
            } else {
                format!("an interrupted rename finished as {destination}: {wanted} was taken")
            });
        }
        move_entry(root, &stage, &entry_name(&destination, folder), folder)?;
    }
    Ok(transaction(journal, id)
        .map(|tx| {
            tx.mappings
                .iter()
                .map(|mapping| (mapping.from.clone(), mapping.to.clone()))
                .collect()
        })
        .unwrap_or_default())
}

fn transaction(journal: &Journal, id: u64) -> Option<&Transaction> {
    journal.transactions.iter().find(|tx| tx.id == id)
}

/// Point a transaction's destination at `destination` instead of `wanted`.
fn relocate(journal: &mut Journal, id: u64, index: usize, wanted: &str, destination: &str) {
    let Some(tx) = journal.transactions.iter_mut().find(|tx| tx.id == id) else {
        return;
    };
    match &mut tx.moves {
        Moves::Folder { to, .. } => {
            *to = destination.to_owned();
            let prefix = format!("{wanted}/");
            for mapping in &mut tx.mappings {
                if let Some(tail) = mapping.to.strip_prefix(&prefix) {
                    mapping.to = format!("{destination}/{tail}");
                }
            }
        }
        Moves::Notes => tx.mappings[index].to = destination.to_owned(),
    }
}

/// A no-replace move links its destination before dropping its source; a
/// crash in between leaves one file under both names. Drop the staged name
/// then, rather than treating our own file as a newcomer.
fn drop_if_already_moved(root: &Path, stage: &str, target: &str) -> Result<bool, String> {
    let target_path = root.join(target);
    let is_file = std::fs::symlink_metadata(&target_path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false);
    if !is_file || !same_file::is_same_file(root.join(stage), &target_path).unwrap_or(false) {
        return Ok(false);
    }
    vault_fs::remove_local(root, stage)?;
    Ok(true)
}

fn entry_name(id: &str, folder: bool) -> String {
    if folder {
        id.to_owned()
    } else {
        crate::note_filename(id)
    }
}

fn free_name(root: &Path, wanted: &str, folder: bool) -> Result<String, String> {
    if folder {
        crate::paths::unique_folder_path(root, wanted, None)
    } else {
        crate::paths::unique_note_id(root, wanted, None)
    }
}
