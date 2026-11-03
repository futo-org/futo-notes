//! A journaled move: sources into staging, then staging into destinations.

use std::path::Path;

use futo_notes_core::files::vault_fs;

use super::{
    load, remove_staging, save, staged, staged_folder, Journal, Mapping, Moves, Phase, Transaction,
    STAGING,
};

/// One journaled move in progress. Callers hold the store gate and the vault
/// guard from `begin` to `commit`.
pub(crate) struct JournaledMove {
    /// `None` when there was nothing to move.
    id: Option<u64>,
}

/// Move every `from` to its `to` through this transaction's staging
/// directory. On `Err` nothing moved and no intent remains. Folder moves pass
/// the folder pair; its notes ride inside it and `mappings` lists them.
pub(crate) fn move_journaled(
    root: &Path,
    mappings: &[(String, String)],
    folder: Option<(&str, &str)>,
) -> Result<JournaledMove, String> {
    if mappings.is_empty() && folder.is_none() {
        return Ok(JournaledMove { id: None });
    }
    let mut journal = load(root)?;
    let id = journal.next_id;
    journal.next_id = id
        .checked_add(1)
        .ok_or("local rename transaction ids exhausted")?;
    journal.transactions.push(Transaction {
        id,
        phase: Phase::Prepared,
        moves: match folder {
            None => Moves::Notes,
            Some((from, to)) => Moves::Folder {
                from: from.to_owned(),
                to: to.to_owned(),
            },
        },
        mappings: mappings
            .iter()
            .map(|(from, to)| Mapping {
                from: from.clone(),
                to: to.clone(),
                object_id: None,
            })
            .collect(),
    });
    save(root, &journal)?;
    let abort = |journal: &mut Journal, error: String| -> String {
        journal.transactions.retain(|tx| tx.id != id);
        if let Err(save_error) = save(root, journal) {
            return format!("{error}; the rename journal could not be cleared: {save_error}");
        }
        remove_staging(root, id);
        error
    };
    if let Err(error) = vault_fs::create_dir_all(root, &format!("{STAGING}/{id}")) {
        return Err(abort(&mut journal, error));
    }

    // Prepared: sources into staging.
    let sources = staging_pairs(mappings, folder, id);
    for (index, (source, stage)) in sources.iter().enumerate() {
        if let Err(error) = move_entry(root, source, stage, folder.is_some()) {
            unstage(root, &sources[..index]);
            return Err(abort(&mut journal, error));
        }
    }
    set_phase(&mut journal, id, Phase::Staged);
    if let Err(error) = step("stage").and_then(|()| save(root, &journal)) {
        unstage(root, &sources);
        return Err(abort(&mut journal, error));
    }

    // Staged: staging into destinations.
    let destinations = destination_pairs(mappings, folder, id);
    for (index, (stage, destination)) in destinations.iter().enumerate() {
        if let Err(error) = move_entry(root, stage, destination, folder.is_some()) {
            // Back through staging, so a crash during the rollback still
            // finds every entry under this transaction.
            for (stage, destination) in destinations[..index].iter().rev() {
                let _ = move_entry(root, destination, stage, folder.is_some());
            }
            set_phase(&mut journal, id, Phase::Prepared);
            let _ = save(root, &journal);
            unstage(root, &sources);
            return Err(abort(&mut journal, error));
        }
    }
    remove_staging(root, id);
    for (source, _) in mappings {
        crate::relink::prune_empty_parents(root, &root.join(crate::note_filename(source)));
    }
    Ok(JournaledMove { id: Some(id) })
}

/// Record that the moves and their backlink rewrite are complete. A failure
/// here leaves the transaction `Staged`; the next recovery commits it.
pub(crate) fn commit(root: &Path, transaction: JournaledMove) -> Result<(), String> {
    let Some(id) = transaction.id else {
        return Ok(());
    };
    step("commit")?;
    let mut journal = load(root)?;
    commit_in(&mut journal, id);
    save(root, &journal)
}

pub(super) fn commit_in(journal: &mut Journal, id: u64) {
    if journal.scope.is_none() {
        journal.transactions.retain(|tx| tx.id != id);
    } else {
        set_phase(journal, id, Phase::Committed);
    }
}

fn set_phase(journal: &mut Journal, id: u64, phase: Phase) {
    if let Some(tx) = journal.transactions.iter_mut().find(|tx| tx.id == id) {
        tx.phase = phase;
    }
}

fn staging_pairs(
    mappings: &[(String, String)],
    folder: Option<(&str, &str)>,
    id: u64,
) -> Vec<(String, String)> {
    match folder {
        Some((from, _)) => vec![(from.to_owned(), staged_folder(id))],
        None => mappings
            .iter()
            .enumerate()
            .map(|(index, (from, _))| (crate::note_filename(from), staged(id, index)))
            .collect(),
    }
}

fn destination_pairs(
    mappings: &[(String, String)],
    folder: Option<(&str, &str)>,
    id: u64,
) -> Vec<(String, String)> {
    match folder {
        Some((_, to)) => vec![(staged_folder(id), to.to_owned())],
        None => mappings
            .iter()
            .enumerate()
            .map(|(index, (_, to))| (staged(id, index), crate::note_filename(to)))
            .collect(),
    }
}

fn unstage(root: &Path, sources: &[(String, String)]) {
    for (source, stage) in sources.iter().rev() {
        let _ = vault_fs::move_no_replace(root, stage, source);
    }
}

/// A named point between durable steps; test fault injection hooks it.
fn step(_name: &str) -> Result<(), String> {
    #[cfg(test)]
    super::tests_support::before_step(_name)?;
    Ok(())
}

/// A no-replace move of a note file, or a folder rename. A folder destination
/// was checked absent under the vault guard; POSIX rename still refuses a
/// non-empty one.
pub(super) fn move_entry(root: &Path, from: &str, to: &str, folder: bool) -> Result<(), String> {
    step(&format!("move {from} -> {to}"))?;
    if folder {
        if vault_fs::exists(root, to)? {
            return Err(format!(
                "rename destination {to} appeared under a concurrent writer"
            ));
        }
        if let Some((parent, _)) = to.rsplit_once('/') {
            vault_fs::create_dir_all(root, parent)?;
        }
        return vault_fs::rename_local(root, from, to).map(|_| ());
    }
    match vault_fs::move_no_replace(root, from, to)? {
        true => Ok(()),
        false if vault_fs::exists(root, from)? => Err(format!(
            "rename destination {to} appeared under a concurrent writer"
        )),
        false => Err(format!("rename source {from} disappeared")),
    }
}
