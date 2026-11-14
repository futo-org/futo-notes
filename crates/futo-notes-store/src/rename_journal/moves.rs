//! A journaled move: sources into staging, then staging into destinations.

use std::path::Path;

use futo_notes_core::files::vault_fs;

use futo_notes_core::files::rename_journal::{
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
/// directory. On `Err` every source is back (one whose name a newcomer took
/// sits beside it, as the error says) and no intent remains, or, if even that
/// failed, the transaction stays recorded for recovery. Folder moves pass
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
                ended: false,
            })
            .collect(),
    });
    save(root, &journal)?;
    if let Err(error) = vault_fs::create_dir_all(root, &format!("{STAGING}/{id}")) {
        journal.transactions.retain(|tx| tx.id != id);
        return Err(match save(root, &journal) {
            Ok(()) => {
                remove_staging(root, id);
                error
            }
            Err(save_error) => {
                format!("{error}; the rename journal could not be cleared: {save_error}")
            }
        });
    }

    // Prepared: sources into staging. The staged name is this transaction's
    // own, so a plain rename (atomic, unlike a link-then-unlink no-replace
    // move) is safe: a crash leaves the entry at exactly one of the two names.
    let sources = staging_pairs(mappings, folder, id);
    for (source, stage) in &sources {
        if let Err(error) = stage_entry(root, source, stage) {
            return Err(roll_back(root, &mut journal, id, error));
        }
    }
    set_phase(&mut journal, id, Phase::Staged);
    if let Err(error) = step("stage").and_then(|()| save(root, &journal)) {
        return Err(roll_back(root, &mut journal, id, error));
    }

    // Staged: staging into destinations.
    let destinations = destination_pairs(mappings, folder, id);
    for (index, (stage, destination)) in destinations.iter().enumerate() {
        let create_parent = folder.is_some()
            || !crate::paths::same_note_parent(&mappings[index].0, &mappings[index].1);
        if let Err(error) = move_entry(root, stage, destination, folder.is_some(), create_parent) {
            // Back through staging, so the undo below (or a recovery after a
            // crash during it) finds every entry under this transaction.
            for (stage, destination) in destinations[..index].iter().rev() {
                let _ = move_entry(root, destination, stage, folder.is_some(), true);
            }
            return Err(roll_back(root, &mut journal, id, error));
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

/// Undo a transaction whose sources may sit in staging: record it as
/// `Prepared`, then put every staged entry back (a newcomer at a source keeps
/// its name; ours takes a fresh one beside it). Whatever cannot be undone now
/// stays recorded for the next recovery, never orphaned in staging.
fn roll_back(root: &Path, journal: &mut Journal, id: u64, error: String) -> String {
    set_phase(journal, id, Phase::Prepared);
    if let Err(save_error) = save(root, journal) {
        return format!("{error}; recovery will settle the rename on restart: {save_error}");
    }
    let Some(tx) = journal.transactions.iter().find(|tx| tx.id == id).cloned() else {
        return error;
    };
    let mut warnings = Vec::new();
    if let Err(restore_error) = super::recovery::restore_sources(root, &tx, &mut warnings) {
        return format!("{error}; undoing it failed, recovery will on restart: {restore_error}");
    }
    journal.transactions.retain(|tx| tx.id != id);
    if let Err(save_error) = save(root, journal) {
        return format!("{error}; the rename journal could not be cleared: {save_error}");
    }
    remove_staging(root, id);
    std::iter::once(error)
        .chain(warnings)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Move a source into its transaction-owned staged name.
fn stage_entry(root: &Path, source: &str, stage: &str) -> Result<(), String> {
    step(&format!("move {source} -> {stage}"))?;
    if vault_fs::rename_local(root, source, stage)? {
        Ok(())
    } else {
        Err(format!("rename source {source} disappeared"))
    }
}

/// A named point between durable steps; test fault injection hooks it.
pub(super) fn step(_name: &str) -> Result<(), String> {
    #[cfg(any(test, feature = "test-support"))]
    super::tests_support::before_step(_name)?;
    Ok(())
}

/// A no-replace move of a note file, or a folder rename. A folder destination
/// was checked absent under the vault guard; POSIX rename still refuses a
/// non-empty one.
pub(super) fn move_entry(
    root: &Path,
    from: &str,
    to: &str,
    folder: bool,
    create_parent: bool,
) -> Result<(), String> {
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
    let install = if create_parent {
        vault_fs::move_no_replace
    } else {
        vault_fs::move_no_replace_in_existing_parent
    };
    match install(root, from, to)? {
        true => Ok(()),
        false if vault_fs::exists(root, from)? => Err(format!(
            "rename destination {to} appeared under a concurrent writer"
        )),
        false => Err(format!("rename source {from} disappeared")),
    }
}
