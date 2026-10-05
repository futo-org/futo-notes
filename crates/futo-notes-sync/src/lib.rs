//! End-to-end encrypted notes sync.
//!
//! [`SyncSession`] is the application API. It owns the connected state, makes
//! sync cycles mutually exclusive, persists progress, and runs live sync.

mod checkpoint;
#[cfg(test)]
mod fault_injection;
mod hosted;
mod journal;
mod open_note;
mod server;
mod session;
mod sync;

use std::path::Path;

use server::HttpClients;

pub use checkpoint::{ConnectedState, ObjectState as E2eeObjectMapEntry};
pub use hosted::{
    hosted_server, probe_sign_in_flow, BillingStatus, Checkout, EntitlementOutcome, HostedError,
    HostedSession, HostedSetup, PairingCode, PairingOutcome, PairingRequest, PollSchedule,
    SetupStep, SignInFlow, SignInHandoff, SignInOutcome, VaultSecrets, HOSTED_SERVER,
    MIN_VAULT_PASSWORD_CHARS,
};
pub use journal::SyncTrigger;
pub use open_note::{classify_open_note, KeepDraftReason, OpenNoteDisposition, OpenNoteFacts};
pub use session::connect::AuthenticatedSession;
pub use session::{HostedCredentials, ResumeCredentials, SyncSession, SyncSessionListener};
pub use sync::{
    ConnectInfo, FailureKind, PreWrite, Progress, RenamePair, SyncErrorKind, SyncFailure,
    SyncProgress, SyncSummary, WriteRefusal,
};

/// Logs in and resolves the collection to sync. The vault stays locked: a
/// session on its own cannot read a note.
///
/// Callers that want password-mode sync use [`SyncSession::connect`], which
/// composes this with [`unlock_with_password`] in the one order that is
/// correct. This verb is separate because the hosted flow authenticates once
/// and then unlocks by a door other than the password.
pub async fn authenticate(
    server: &str,
    password: &str,
) -> Result<AuthenticatedSession, SyncErrorKind> {
    let clients = HttpClients::new().map_err(session::connect::http_error)?;
    session::connect::authenticate(&clients, server, password).await
}

/// Turns an authenticated session into the 32-byte vault key by unwrapping the
/// collection's key material with the vault password, minting that material
/// when a fresh collection has none.
pub async fn unlock_with_password(
    session: &AuthenticatedSession,
    password: &str,
) -> Result<[u8; 32], SyncErrorKind> {
    session::connect::unlock_with_password(session, password).await
}

// Kept as a narrow compatibility surface for the server acceptance tests.
// Applications use SyncSession instead.
#[doc(hidden)]
pub async fn connect(
    root: &Path,
    server: &str,
    password: &str,
) -> Result<(ConnectedState, ConnectInfo), SyncErrorKind> {
    let clients = server::HttpClients::new().map_err(session::connect::http_error)?;
    session::connect::connect(&clients, root, server, password).await
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
    let clients = server::HttpClients::new().map_err(session::connect::http_error)?;
    session::connect::resume(
        &clients,
        root,
        server,
        token,
        user_id,
        collection_id,
        password,
    )
    .await
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
    // The journal is attached to a `SyncSession`, which this compatibility
    // wrapper does not have; the acceptance tests that call it assert on files
    // and summaries, not on journal contents.
    sync::cycle(
        state,
        root,
        progress,
        pre_write,
        &journal::SyncRunJournal::disabled(),
    )
    .await
}

/// Test-only: demote a vault's live sync state to ancestry (what disconnect does).
#[doc(hidden)]
pub fn demote_state_to_ancestry(root: &std::path::Path) -> Result<(), String> {
    checkpoint::demote(root)
}
