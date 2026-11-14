//! Finishing or undoing transactions a crash or failure left behind.

use std::path::Path;

use futo_notes_core::files::vault_fs;

use super::moves::{commit_in, move_entry};
use futo_notes_core::files::rename_journal::{
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
        let mut recovered_parent = !folder && parent_missing(root, &source)?;
        if recovered_parent {
            if let Some(home) = existing_root_recovery(root, &stage, &source)? {
                vault_fs::remove_local(root, &stage)?;
                warnings.push(format!("an interrupted rename of {source} was recovered as {home}: its folder disappeared"));
                continue;
            }
        }
        let mut home = if recovered_parent {
            recovered_root_name(root, &source)?
        } else {
            free_name(root, &source, folder)?
        };
        if let Err(error) = move_entry(root, &stage, &entry_name(&home, folder), folder, folder) {
            // It can disappear after the decision too. Never repair the old
            // directory as a side effect of undoing a title rename.
            if folder || recovered_parent || !parent_missing(root, &source)? {
                return Err(error);
            }
            recovered_parent = true;
            home = recovered_root_name(root, &source)?;
            move_entry(root, &stage, &entry_name(&home, false), false, false)?;
        }
        if home != source {
            warnings.push(if recovered_parent {
                format!("an interrupted rename of {source} was recovered as {home}: its folder disappeared")
            } else {
                format!("an interrupted rename of {source} was undone as {home}: the name was taken")
            });
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
        let (wanted, folder, create_parent) = match &tx.moves {
            Moves::Folder { to, .. } => (to.clone(), true, true),
            Moves::Notes => (
                tx.mappings[index].to.clone(),
                false,
                !crate::paths::same_note_parent(&tx.mappings[index].from, &tx.mappings[index].to),
            ),
        };
        if !folder && drop_if_already_moved(root, &stage, &crate::note_filename(&wanted))? {
            continue;
        }
        let source = if folder {
            wanted.clone()
        } else {
            tx.mappings[index].from.clone()
        };
        let vanished_parent = !folder && !create_parent && parent_missing(root, &wanted)?;
        let existing_recovery = if vanished_parent {
            existing_root_recovery(root, &stage, &source)?
        } else {
            None
        };
        let destination = if vanished_parent {
            match &existing_recovery {
                Some(home) => home.clone(),
                None => recovered_root_name(root, &source)?,
            }
        } else {
            free_name(root, &wanted, folder)?
        };
        if destination != wanted {
            relocate(journal, id, index, &wanted, &destination);
            save(root, journal)?;
            warnings.push(if vanished_parent {
                format!("an interrupted rename of {source} was recovered as {destination}: its folder disappeared")
            } else if folder {
                format!("an interrupted folder move finished as {destination}: {wanted} was taken")
            } else {
                format!("an interrupted rename finished as {destination}: {wanted} was taken")
            });
        }
        if existing_recovery.is_some() {
            vault_fs::remove_local(root, &stage)?;
            continue;
        }
        if let Err(error) = move_entry(
            root,
            &stage,
            &entry_name(&destination, folder),
            folder,
            create_parent,
        ) {
            if folder || create_parent || vanished_parent || !parent_missing(root, &wanted)? {
                return Err(error);
            }
            let recovered = recovered_root_name(root, &source)?;
            relocate(journal, id, index, &destination, &recovered);
            save(root, journal)?;
            move_entry(root, &stage, &entry_name(&recovered, false), false, false)?;
            warnings.push(format!("an interrupted rename of {source} was recovered as {recovered}: its folder disappeared"));
        }
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
    if !same_installed_file(root, stage, target) {
        return Ok(false);
    }
    vault_fs::remove_local(root, stage)?;
    Ok(true)
}

fn same_installed_file(root: &Path, stage: &str, target: &str) -> bool {
    let target_path = root.join(target);
    let is_file = std::fs::symlink_metadata(&target_path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false);
    is_file && same_file::is_same_file(root.join(stage), &target_path).unwrap_or(false)
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

fn parent_missing(root: &Path, id: &str) -> Result<bool, String> {
    let (folder, _) = futo_notes_model::split_id(id);
    if folder.is_empty() {
        return Ok(false);
    }
    vault_fs::exists(root, &folder).map(|exists| !exists)
}

fn recovered_root_name(root: &Path, source: &str) -> Result<String, String> {
    free_name(root, &recovered_root_stem(source), false)
}

fn recovered_root_stem(source: &str) -> String {
    let (_, title) = futo_notes_model::split_id(source);
    futo_notes_model::make_id("", &format!("{title} (recovered)"))
}

/// The no-replace fallback can link before it unlinks staging. A crash there
/// must adopt that same recovered file rather than minting a second copy.
fn existing_root_recovery(
    root: &Path,
    stage: &str,
    source: &str,
) -> Result<Option<String>, String> {
    let stem = recovered_root_stem(source);
    for (id, _) in crate::vault::note_paths(root) {
        if futo_notes_model::split_id(&id).0.is_empty()
            && crate::paths::is_unique_variant(&stem, &id)
            && same_installed_file(root, stage, &crate::note_filename(&id))
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}
