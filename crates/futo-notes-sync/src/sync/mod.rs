use std::path::Path;

use crate::checkpoint::ConnectedState;

mod collision_resolution;
mod conflict_resolution;
mod encrypted_note;
mod object_map;
mod outcome;
mod pull;
mod push;
mod tombstones;
mod vault;

use outcome::combine;
pub use outcome::{
    ConnectInfo, FailureKind, PreWrite, Progress, RenamePair, SyncErrorKind, SyncFailure,
    SyncProgress, SyncSummary,
};
pub(crate) use pull::pull;
pub(crate) use push::push;

pub(crate) async fn cycle(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    let (bootstrap, ready) = if state.object_map.is_empty() && state.max_version == 0 {
        pull(state, root, 0, progress, pre_write).await?
    } else {
        (SyncSummary::default(), state.clone())
    };
    let pull_since = ready.pull_cursor;
    let (pushed, after_push) = push(&ready, root, progress, pre_write).await?;
    let (pulled, after_pull) = pull(&after_push, root, pull_since, progress, pre_write).await?;
    Ok((combine(bootstrap, combine(pushed, pulled)), after_pull))
}

#[cfg(test)]
mod behavior_tests;
