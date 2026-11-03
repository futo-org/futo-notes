//! Committed local renames (#214). The store journals exactly which note file
//! moved where, so the server object that was at the source follows it to the
//! destination whatever its content became. Nothing here guesses: no hash, no
//! basename, no title. A move with no server object behind it (never synced,
//! or a pending create) has no identity to carry and is simply acknowledged.
//!
//! Order of durability, so a crash anywhere replays to the same object:
//! 1. bind: the journal records the source object id (under the vault guard);
//! 2. rekey: the checkpoint's one entry for that object moves to the
//!    destination in memory, and the destination uploads as a PUT of it;
//! 3. acknowledge: only after that PUT succeeded AND the checkpoint holding its
//!    result saved. A replay before that finds the bound object wherever the
//!    checkpoint last put it and forces the PUT again.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use futo_notes_store::rename_journal::{with_rename_journal, RenameIntent};

use crate::checkpoint::ConnectedState;
use crate::sync::object_map::mapped_name;
use crate::sync::outcome::note_id;
use crate::sync::vault::LocalFile;
use crate::sync::{decision, RenamePair, SyncPhase, SyncSummary};

use super::reason;

/// What this cycle took from the journal.
#[derive(Default)]
pub(in crate::sync) struct ClaimedRenames {
    /// Destinations that must upload as a PUT of their carried object even
    /// when the bytes are unchanged.
    pub(in crate::sync) destinations: HashSet<String>,
    /// Checkpoint names a pending rename still owns this cycle: never delete
    /// them as missing, never let a pull relocate them.
    pub(in crate::sync) held: HashSet<String>,
    claims: Vec<Claim>,
}

struct Claim {
    transactions: HashSet<u64>,
    destination: String,
    object_id: String,
    baseline_version: u64,
}

/// A run of intents that moved one file: A->B then B->C is one chain A->C.
struct Chain {
    origin: String,
    current: String,
    head: u64,
    transactions: HashSet<u64>,
    object_id: Option<String>,
}

fn chains(intents: Vec<RenameIntent>) -> Vec<Chain> {
    let mut chains: Vec<Chain> = Vec::new();
    for intent in intents {
        if let Some(chain) = chains.iter_mut().find(|chain| chain.current == intent.from) {
            chain.current = intent.to;
            chain.transactions.insert(intent.transaction);
            chain.object_id = chain.object_id.take().or(intent.object_id);
            continue;
        }
        chains.push(Chain {
            origin: intent.from,
            current: intent.to,
            head: intent.transaction,
            transactions: HashSet::from([intent.transaction]),
            object_id: intent.object_id,
        });
    }
    chains
}

/// Bind and rekey every committed rename whose destination this scan saw.
pub(in crate::sync) fn claim_local_renames(
    state: &mut ConnectedState,
    root: &Path,
    files: &[LocalFile],
    summary: &mut SyncSummary,
) -> Result<ClaimedRenames, String> {
    let present: HashSet<&str> = files.iter().map(|file| file.name.as_str()).collect();
    with_rename_journal(root, |journal| {
        let mut claimed = ClaimedRenames::default();
        let mut settled = HashSet::new();
        for chain in chains(journal.intents()) {
            let owner = match &chain.object_id {
                Some(object_id) => mapped_name(state, object_id),
                None => state
                    .object_map
                    .contains_key(&chain.origin)
                    .then(|| chain.origin.clone()),
            };
            let Some(owner) = owner else {
                // Never on the server under this checkpoint: nothing to carry.
                settled.extend(chain.transactions);
                continue;
            };
            let destination = chain.current;
            if owner == destination && chain.object_id.is_none() {
                // Renamed back before any claim: identity never moved.
                settled.extend(chain.transactions);
                continue;
            }
            if !present.contains(destination.as_str()) {
                if present.contains(owner.as_str()) {
                    // The move landed after this scan; the next cycle owns it.
                    claimed.held.insert(owner);
                } else {
                    // Moved, then deleted: the ordinary delete takes over.
                    settled.extend(chain.transactions);
                }
                continue;
            }
            let entry = state.object_map[&owner].clone();
            if owner != destination
                && state
                    .object_map
                    .get(&destination)
                    .is_some_and(|other| other.object_id != entry.object_id)
            {
                // The destination name still maps another object (a local
                // delete not yet pushed). Carrying ours there would drop that
                // delete; the pre-journal name pairing applies instead.
                summary.decide_with(
                    SyncPhase::Push,
                    &owner,
                    decision::IGNORED,
                    reason::RENAME_TARGET_MAPPED,
                    destination.clone(),
                );
                settled.extend(chain.transactions);
                continue;
            }
            journal.bind(chain.head, &chain.origin, &entry.object_id);
            if owner != destination {
                state.object_map.remove(&owner);
                state.object_map.insert(destination.clone(), entry.clone());
                summary.decide_with(
                    SyncPhase::Push,
                    &owner,
                    decision::RENAME_DETECTED,
                    reason::LOCAL_RENAME_INTENT,
                    destination.clone(),
                );
                summary.renamed.push(RenamePair {
                    from_id: note_id(&owner),
                    to_id: note_id(&destination),
                });
            }
            claimed.held.insert(destination.clone());
            claimed.destinations.insert(destination.clone());
            claimed.claims.push(Claim {
                transactions: chain.transactions,
                destination,
                object_id: entry.object_id,
                baseline_version: entry.version,
            });
        }
        journal.acknowledge(&settled);
        claimed
    })
}

/// After the push's checkpoint saved: drop the intents whose PUT landed.
pub(in crate::sync) fn acknowledge_uploaded(
    root: &Path,
    claimed: &ClaimedRenames,
    state: &ConnectedState,
) -> Result<(), String> {
    let landed = landed(claimed, &state.object_map);
    if landed.is_empty() {
        return Ok(());
    }
    with_rename_journal(root, |journal| journal.acknowledge(&landed))
}

fn landed(
    claimed: &ClaimedRenames,
    object_map: &HashMap<String, crate::checkpoint::ObjectState>,
) -> HashSet<u64> {
    claimed
        .claims
        .iter()
        .filter(|claim| {
            object_map.get(&claim.destination).is_some_and(|entry| {
                entry.object_id == claim.object_id && entry.version > claim.baseline_version
            })
        })
        .flat_map(|claim| claim.transactions.iter().copied())
        .collect()
}

/// Checkpoint names a still-pending rename owns, for the pull to leave alone.
pub(in crate::sync) fn pending_rename_paths(
    state: &ConnectedState,
    root: &Path,
) -> HashSet<String> {
    with_rename_journal(root, |journal| {
        chains(journal.intents())
            .into_iter()
            .filter_map(|chain| match chain.object_id {
                Some(object_id) => mapped_name(state, &object_id),
                None => state
                    .object_map
                    .contains_key(&chain.origin)
                    .then_some(chain.origin),
            })
            .collect()
    })
    .unwrap_or_default()
}
