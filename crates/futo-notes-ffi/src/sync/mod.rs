mod client;
mod contract;
mod events;
mod hosted;

pub use client::SyncClient;
pub use contract::{
    classify_open_note, ConnectInfo, KeepDraftReason, OpenNoteDisposition, OpenNoteFacts,
    RenamePair, SyncError, SyncFailure, SyncStatus, SyncSummary,
};
pub use events::SyncEventListener;
pub use hosted::{
    hosted_server_url, min_vault_password_length, probe_sign_in_flow, BillingStatus, Checkout,
    EntitlementOutcome, HostedError, HostedSession, HostedSetupClient, SecretStoreError, SetupStep,
    SignInFlow, SignInHandoff, SignInOutcome, VaultSecretStore,
};

pub(crate) use events::session_listener;
