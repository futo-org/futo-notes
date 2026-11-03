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
    /// The store deleted the file at `to` afterwards.
    pub ended: bool,
}

/// The journal as sync sees it, inside one vault-guarded span.
pub struct RenameJournal {
    journal: Journal,
    changed: bool,
}

impl RenameJournal {
    /// Committed moves in the journal's scope, oldest first.
    pub fn intents(&self) -> Vec<RenameIntent> {
        intents_of(&self.journal)
    }

    /// The committed moves as one chain per moved file, oldest first.
    pub fn chains(&self) -> Vec<RenameChain> {
        chains(self.intents())
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

    /// Drop the committed intents whose outcome sync has durably recorded.
    /// A transaction moving several notes stays until each of them settles.
    pub fn acknowledge(&mut self, intents: &HashSet<IntentKey>) {
        self.changed |= forget(&mut self.journal, intents);
    }
}

/// One committed intent: its transaction and source filename.
pub type IntentKey = (u64, String);

/// The committed moves of one file: A->B then B->C is one chain A->C.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameChain {
    /// The filename the file had before its first move.
    pub origin: String,
    /// Where the file is now; `None` once the store deleted it there, or a
    /// later move took that name (which the store only allocates when it is
    /// free: the file had already gone).
    pub current: Option<String>,
    /// The transaction of the first move, where a binding is recorded.
    pub head: u64,
    pub intents: Vec<IntentKey>,
    pub object_id: Option<String>,
    /// The origin name had already been moved away from (or the moved file
    /// deleted there): this file was created there afterwards and owns
    /// nothing a checkpoint recorded there.
    pub fresh: bool,
}

fn intents_of(journal: &Journal) -> Vec<RenameIntent> {
    journal
        .transactions
        .iter()
        .filter(|tx| tx.phase == Phase::Committed)
        .flat_map(|tx| {
            tx.mappings.iter().map(|mapping| RenameIntent {
                transaction: tx.id,
                from: crate::note_filename(&mapping.from),
                to: crate::note_filename(&mapping.to),
                object_id: mapping.object_id.clone(),
                ended: mapping.ended,
            })
        })
        .collect()
}

fn chains(intents: Vec<RenameIntent>) -> Vec<RenameChain> {
    let mut chains: Vec<RenameChain> = Vec::new();
    let mut vacated = HashSet::new();
    for intent in intents {
        let extends = chains
            .iter()
            .position(|chain| chain.current.as_deref() == Some(intent.from.as_str()));
        for (index, chain) in chains.iter_mut().enumerate() {
            if Some(index) != extends && chain.current.as_deref() == Some(intent.to.as_str()) {
                chain.current = None;
            }
        }
        let key = (intent.transaction, intent.from.clone());
        let fresh = !vacated.insert(intent.from.clone());
        if intent.ended {
            // The moved file was deleted there: a later file at that name is
            // new, even where a checkpoint already maps the name.
            vacated.insert(intent.to.clone());
        }
        let current = (!intent.ended).then_some(intent.to);
        if let Some(index) = extends {
            let chain = &mut chains[index];
            chain.current = current;
            chain.intents.push(key);
            chain.object_id = chain.object_id.take().or(intent.object_id);
            continue;
        }
        chains.push(RenameChain {
            origin: intent.from,
            current,
            head: intent.transaction,
            intents: vec![key],
            object_id: intent.object_id,
            fresh,
        });
    }
    chains
}

fn forget(journal: &mut Journal, intents: &HashSet<IntentKey>) -> bool {
    if intents.is_empty() {
        return false;
    }
    let mut changed = false;
    for tx in &mut journal.transactions {
        if tx.phase != Phase::Committed {
            continue;
        }
        let id = tx.id;
        let before = tx.mappings.len();
        tx.mappings
            .retain(|mapping| !intents.contains(&(id, crate::note_filename(&mapping.from))));
        changed |= tx.mappings.len() != before;
    }
    journal
        .transactions
        .retain(|tx| tx.phase != Phase::Committed || !tx.mappings.is_empty());
    changed
}

/// The store deleted `filename` (vault guard held): a pending rename that
/// ended there is over, so no later file at that name can inherit it. The
/// intents stay, marked, until sync settles them: they are also the evidence
/// that a later file at a vacated origin is a new one.
pub(crate) fn forget_deleted_locked(root: &Path, filename: &str) -> Result<(), String> {
    let mut journal = load(root)?;
    let ended = chains(intents_of(&journal))
        .into_iter()
        .filter(|chain| chain.current.as_deref() == Some(filename))
        .filter_map(|chain| chain.intents.last().cloned())
        .collect::<HashSet<_>>();
    if ended.is_empty() {
        return Ok(());
    }
    for tx in &mut journal.transactions {
        if tx.phase != Phase::Committed {
            continue;
        }
        let id = tx.id;
        for mapping in &mut tx.mappings {
            if ended.contains(&(id, crate::note_filename(&mapping.from))) {
                mapping.ended = true;
            }
        }
    }
    save(root, &journal)
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
