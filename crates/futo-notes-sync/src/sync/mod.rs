use std::path::Path;

use crate::checkpoint::{self, ConnectedState};

mod collision_resolution;
mod conflict_resolution;
mod encrypted_note;
mod object_map;
mod outcome;
mod pull;
mod push;
mod tombstones;
mod vault;
mod vault_fs;

use outcome::combine;
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
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    cycle_with_checkpoint(state, root, progress, pre_write, &checkpoint::save)
        .await
        .map_err(|failure| failure.kind)
}

pub(crate) async fn cycle_with_checkpoint(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
) -> Result<(SyncSummary, ConnectedState), CycleFailure> {
    let (bootstrap, ready) = if state.object_map.is_empty() && state.max_version == 0 {
        pull::pull_with_checkpoint(state, root, 0, progress, pre_write, save_checkpoint)
            .await
            .map_err(|kind| CycleFailure {
                kind,
                state: state.clone(),
            })?
    } else {
        (SyncSummary::default(), state.clone())
    };
    let pull_since = ready.pull_cursor;
    let (pushed, after_push) =
        push::push_with_checkpoint(&ready, root, progress, pre_write, save_checkpoint).await?;
    let (pulled, after_pull) = pull::pull_with_checkpoint(
        &after_push,
        root,
        pull_since,
        progress,
        pre_write,
        save_checkpoint,
    )
    .await
    .map_err(|kind| CycleFailure {
        kind,
        state: after_push,
    })?;
    Ok((combine(bootstrap, combine(pushed, pulled)), after_pull))
}

#[cfg(test)]
mod behavior_tests;
