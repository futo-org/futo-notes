//! The sync-facing surface: committed intents, binding and acknowledgement.

use std::collections::HashSet;
use std::path::Path;

use futo_notes_core::files::vault_mutation_guard;

use super::{load, save, Journal, Phase};

// The sync-facing surface.

/// One committed note move, in commit order. Paths are vault filenames
/// (`.md` included), the names sync's checkpoint uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameIntent {
    pub transaction: u64,
    pub from: String,
    pub to: String,
    /// Set by [`RenameJournal::bind`]; never by the store.
    pub object_id: Option<String>,
}

/// The journal as sync sees it, inside one vault-guarded span.
pub struct RenameJournal {
    journal: Journal,
    changed: bool,
}

impl RenameJournal {
    /// Committed moves in the journal's scope, oldest first.
    pub fn intents(&self) -> Vec<RenameIntent> {
        self.journal
            .transactions
            .iter()
            .filter(|tx| tx.phase == Phase::Committed)
            .flat_map(|tx| {
                tx.mappings.iter().map(|mapping| RenameIntent {
                    transaction: tx.id,
                    from: crate::note_filename(&mapping.from),
                    to: crate::note_filename(&mapping.to),
                    object_id: mapping.object_id.clone(),
                })
            })
            .collect()
    }

    /// Persist the server object a move carries, before sync rekeys its
    /// checkpoint to the destination.
    pub fn bind(&mut self, transaction: u64, from: &str, object_id: &str) {
        for tx in &mut self.journal.transactions {
            if tx.id != transaction {
                continue;
            }
            for mapping in &mut tx.mappings {
                if crate::note_filename(&mapping.from) == from
                    && mapping.object_id.as_deref() != Some(object_id)
                {
                    mapping.object_id = Some(object_id.to_owned());
                    self.changed = true;
                }
            }
        }
    }

    /// Drop transactions whose outcome sync has durably recorded.
    pub fn acknowledge(&mut self, transactions: &HashSet<u64>) {
        let before = self.journal.transactions.len();
        self.journal
            .transactions
            .retain(|tx| tx.phase != Phase::Committed || !transactions.contains(&tx.id));
        self.changed |= self.journal.transactions.len() != before;
    }
}

/// Run `f` over the committed intents under the vault guard, saving whatever
/// it bound or acknowledged. Fails while an interrupted move awaits recovery
/// (the store's next bootstrap or rename finishes it), and on a journal this
/// binary cannot read. `f` must not take the vault guard.
pub fn with_rename_journal<R>(
    root: &Path,
    f: impl FnOnce(&mut RenameJournal) -> R,
) -> Result<R, String> {
    let _vault_mutation = vault_mutation_guard()?;
    with_rename_journal_locked(root, f)
}

fn with_rename_journal_locked<R>(
    root: &Path,
    f: impl FnOnce(&mut RenameJournal) -> R,
) -> Result<R, String> {
    let journal = load(root)?;
    if journal
        .transactions
        .iter()
        .any(|tx| tx.phase != Phase::Committed)
    {
        return Err("an interrupted local rename has not been recovered yet".to_owned());
    }
    let mut view = RenameJournal {
        journal,
        changed: false,
    };
    let result = f(&mut view);
    if view.changed {
        save(root, &view.journal)?;
    }
    Ok(result)
}

/// Point the journal at the sync checkpoint for `scope` (`None` once the vault
/// has none). A change drops every committed intent: they name paths of the
/// old checkpoint and must never bind to a coincidentally equal path in
/// another. Interrupted moves are left for recovery.
pub fn set_rename_scope(root: &Path, scope: Option<&str>) -> Result<(), String> {
    let _vault_mutation = vault_mutation_guard()?;
    let mut journal = load(root)?;
    if journal.scope.as_deref() == scope {
        return Ok(());
    }
    journal.scope = scope.map(str::to_owned);
    journal
        .transactions
        .retain(|tx| tx.phase != Phase::Committed);
    save(root, &journal)
}
