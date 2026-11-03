//! Finishing or undoing transactions a crash or failure left behind.

use std::path::Path;

use futo_notes_core::files::vault_fs;

use super::moves::{commit_in, move_entry};
use super::{load, remove_staging, save, staged, staged_folder, Moves, Phase, Transaction};

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
                let mappings = place_destinations(root, &tx, &mut recovered.warnings)?;
                if let Some(entry) = journal
                    .transactions
                    .iter_mut()
                    .find(|other| other.id == tx.id)
                {
                    for (mapping, (_, to)) in entry.mappings.iter_mut().zip(&mappings) {
                        mapping.to = to.clone();
                    }
                }
                recovered.finished.push((tx.id, mappings));
            }
            Phase::Committed => {}
        }
        remove_staging(root, tx.id);
    }
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
fn restore_sources(
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

/// Finish a `Staged` transaction. Returns the final mappings.
fn place_destinations(
    root: &Path,
    tx: &Transaction,
    warnings: &mut Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    let mut mappings = tx
        .mappings
        .iter()
        .map(|mapping| (mapping.from.clone(), mapping.to.clone()))
        .collect::<Vec<_>>();
    for (index, stage) in staged_entries(tx) {
        if !vault_fs::exists(root, &stage)? {
            continue;
        }
        match &tx.moves {
            Moves::Folder { to, .. } => {
                let destination = free_name(root, to, true)?;
                move_entry(root, &stage, &destination, true)?;
                if &destination != to {
                    warnings.push(format!(
                        "an interrupted folder move finished as {destination}: {to} was taken"
                    ));
                    let prefix = format!("{to}/");
                    for (_, mapped) in &mut mappings {
                        if let Some(tail) = mapped.strip_prefix(&prefix) {
                            *mapped = format!("{destination}/{tail}");
                        }
                    }
                }
            }
            Moves::Notes => {
                let to = mappings[index].1.clone();
                let destination = free_name(root, &to, false)?;
                move_entry(root, &stage, &crate::note_filename(&destination), false)?;
                if destination != to {
                    warnings.push(format!(
                        "an interrupted rename finished as {destination}: {to} was taken"
                    ));
                    mappings[index].1 = destination;
                }
            }
        }
    }
    Ok(mappings)
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
