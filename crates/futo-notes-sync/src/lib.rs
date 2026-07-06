//! `futo-notes-sync` — a Tauri-free E2EE sync + auth client.
//!
//! Ports the crypto (`futo-notes-core::e2ee`), the reqwest HTTP client
//! (`client`), the object-map persistence (`state`), and a streamlined sync
//! orchestrator (`orchestrator`).
//!
//! This crate is a PLAIN Rust library: the UniFFI surface (the `SyncClient`
//! object Swift/Kotlin call) now lives in `futo-notes-ffi`, the single FFI
//! facade. `futo-notes-ffi` consumes the orchestrator through these public
//! modules.

pub mod client;
pub mod live;
pub mod orchestrator;
pub mod session;
pub mod state;

// Re-export the types FFI/app consumers need at the crate root for
// convenience.
pub use orchestrator::{
    auth_mode_str, connect, resume, run_pull, run_push, run_sync, ConnectResult, FailureKind,
    HashFilenameEntry, RenamePair, SyncErrorKind, SyncFailure, SyncProgress, SyncSummary,
};
pub use live::{LiveHandle, SyncSessionListener};
pub use session::{AbortableTask, SyncSession};
pub use state::{ConnectedState, E2eeObjectMapEntry};
