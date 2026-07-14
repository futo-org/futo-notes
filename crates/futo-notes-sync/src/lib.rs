//! End-to-end encrypted notes sync.
//!
//! [`SyncSession`] is the application API. It owns the connected state, makes
//! sync cycles mutually exclusive, persists progress, and runs live sync.

mod checkpoint;
mod server;
mod session;
mod sync;

use std::path::Path;

pub use checkpoint::{ConnectedState, ObjectState as E2eeObjectMapEntry};
pub use session::{ResumeCredentials, SyncSession, SyncSessionListener};
pub use sync::{
    ConnectInfo, FailureKind, PreWrite, Progress, RenamePair, SyncErrorKind, SyncFailure,
    SyncProgress, SyncSummary,
};

// Kept as a narrow compatibility surface for the server acceptance tests.
// Applications use SyncSession instead.
#[doc(hidden)]
pub async fn connect(
    root: &Path,
    server: &str,
    password: &str,
) -> Result<(ConnectedState, ConnectInfo), SyncErrorKind> {
    session::connect::connect(root, server, password).await
}

#[doc(hidden)]
pub async fn resume(
    root: &Path,
    server: &str,
    token: &str,
    user_id: &str,
    collection_id: &str,
    password: &str,
) -> Result<ConnectedState, SyncErrorKind> {
    session::connect::resume(root, server, token, user_id, collection_id, password).await
}

#[doc(hidden)]
pub async fn run_push(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    sync::push(state, root, progress, pre_write).await
}

#[doc(hidden)]
pub async fn run_pull(
    state: &ConnectedState,
    root: &Path,
    since: u64,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    sync::pull(state, root, since, progress, pre_write).await
}

#[doc(hidden)]
pub async fn run_sync(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    sync::cycle(state, root, progress, pre_write).await
}

#[doc(hidden)]
pub mod state {
    pub use crate::checkpoint::{ConnectedState, ObjectState as E2eeObjectMapEntry};

    pub fn demote_state_to_ancestry(root: &std::path::Path) -> Result<(), String> {
        crate::checkpoint::demote(root)
    }
}
