use std::collections::HashSet;
use std::path::Path;

use crate::checkpoint::{self, ConnectedState};

mod chunking;
mod collision_resolution;
mod conflict_resolution;
mod encrypted_note;
mod object_map;
mod outcome;
mod pull;
mod push;
#[cfg(test)]
mod test_support;
mod tombstones;
mod transfer;
mod transfer_retry;
mod vault;
mod vault_fs;

use crate::journal::{elapsed_ms, PhaseTimings, SyncRunJournal};
use outcome::combine;
pub(super) use outcome::SyncPhase;
pub(crate) use outcome::{decision, ReconcileDecision};
pub use outcome::{
    ConnectInfo, FailureKind, PreWrite, Progress, RenamePair, SyncErrorKind, SyncFailure,
    SyncProgress, SyncSummary,
};
pub(crate) use pull::pull;
pub(crate) use push::push;
pub(crate) type SaveCheckpoint = dyn Fn(&Path, &ConnectedState) -> Result<(), String> + Send + Sync;

pub(crate) struct CycleFailure {
    pub(crate) kind: SyncErrorKind,
    pub(crate) state: ConnectedState,
}

pub(crate) async fn cycle(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    run_journal: &SyncRunJournal,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    cycle_with_checkpoint(
        state,
        root,
        progress,
        pre_write,
        &checkpoint::save,
        run_journal,
    )
    .await
    .map_err(|failure| failure.kind)
}

/// The visible push-first sequence: an optional bootstrap pull, then the push,
/// then the pull from the cursor captured *before* the push. The journal wraps
/// this without participating in it — every measurement is taken around a call
/// whose arguments and ordering are unchanged.
pub(crate) async fn cycle_with_checkpoint(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
    run_journal: &SyncRunJournal,
) -> Result<(SyncSummary, ConnectedState), CycleFailure> {
    let cycle_started = std::time::Instant::now();
    let mut phases = PhaseTimings::default();
    let abandon = |kind: SyncErrorKind, reached: &ConnectedState, phases: PhaseTimings| {
        run_journal.record(
            state,
            reached,
            PhaseTimings {
                total_ms: elapsed_ms(cycle_started),
                ..phases
            },
            Err(&kind),
        );
        CycleFailure {
            kind,
            state: reached.clone(),
        }
    };

    let (bootstrap, ready) = if needs_bootstrap(state) {
        let started = std::time::Instant::now();
        let bootstrapped =
            pull::pull_with_checkpoint(state, root, 0, progress, pre_write, save_checkpoint).await;
        phases.bootstrap_ms = elapsed_ms(started);
        match bootstrapped {
            Ok(bootstrapped) => bootstrapped,
            Err(kind) => return Err(abandon(kind, state, phases)),
        }
    } else {
        (SyncSummary::default(), state.clone())
    };
    let pull_since = ready.pull_cursor;
    let started = std::time::Instant::now();
    let pushed =
        push::push_with_checkpoint(&ready, root, progress, pre_write, save_checkpoint).await;
    phases.push_ms = elapsed_ms(started);
    let (pushed, after_push) = match pushed {
        Ok(pushed) => pushed,
        Err(CycleFailure {
            kind,
            state: reached,
        }) => return Err(abandon(kind, &reached, phases)),
    };

    let protected_paths = dirty_mapped_paths(&after_push, root);
    let started = std::time::Instant::now();
    let pulled = pull::pull_with_checkpoint_protected(
        &after_push,
        root,
        pull_since,
        progress,
        pre_write,
        save_checkpoint,
        &protected_paths,
    )
    .await;
    phases.pull_ms = elapsed_ms(started);
    let (pulled, after_pull) = match pulled {
        Ok(pulled) => pulled,
        Err(kind) => return Err(abandon(kind, &after_push, phases)),
    };

    phases.total_ms = elapsed_ms(cycle_started);
    let summary = combine(bootstrap, combine(pushed, pulled));
    run_journal.record(state, &after_pull, phases, Ok(&summary));
    Ok((summary, after_pull))
}

fn dirty_mapped_paths(state: &ConnectedState, root: &Path) -> HashSet<String> {
    state
        .object_map
        .iter()
        .filter_map(|(name, entry)| {
            let expected = entry.hash.as_deref()?;
            let current = vault::content_hash(root, name);
            (current.as_deref() != Some(expected)).then(|| name.clone())
        })
        .collect()
}

fn needs_bootstrap(state: &ConnectedState) -> bool {
    state.object_map.is_empty() && state.pending_creates.is_empty() && state.max_version == 0
}

#[cfg(test)]
mod behavior_tests;
#[cfg(test)]
mod failure_boundary_tests;
