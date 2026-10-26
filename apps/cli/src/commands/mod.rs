//! Command families. Each loads configuration, takes the vault lock, calls the
//! owning engine, and formats the outcome — no note rule or sync rule lives here.

pub mod auth;
pub mod edit;
pub mod init;
pub mod notes;
pub mod status;
pub mod sync;

use std::path::PathBuf;

use futo_notes_store::{LocalNoteStore, MutationResult};
use serde_json::{json, Value};

use crate::config;
use crate::error::{CliError, CliResult};
use crate::i18n::tf;
use crate::lock::{self, VaultLock};
use crate::output::Output;
use crate::vault;

pub struct Context {
    pub out: Output,
    /// The global `--vault`, for this one command.
    pub vault: Option<PathBuf>,
}

/// An open vault: its canonical root, the store over it, and the CLI lock,
/// held for as long as this value lives.
pub struct OpenVault {
    pub root: PathBuf,
    pub store: LocalNoteStore,
    _lock: VaultLock,
}

impl Context {
    /// The selected vault, locked. Nothing here bootstraps: no migration, no
    /// welcome note — `LocalNoteStore::new` and the workflows only.
    pub fn open(&self) -> CliResult<OpenVault> {
        let config = config::load()?;
        let root = vault::select(&config, self.vault.as_deref())?;
        self.open_root(root)
    }

    pub fn open_root(&self, root: PathBuf) -> CliResult<OpenVault> {
        let lock = lock::lock(&root)?;
        Ok(OpenVault {
            store: LocalNoteStore::new(root.clone()),
            root,
            _lock: lock,
        })
    }
}

/// The shared path rule for an ID: relative, `/`-separated, no `..`, no
/// absolute prefix, no character the filesystem rules forbid.
pub fn check_id(id: &str) -> CliResult<()> {
    futo_notes_core::files::ensure_safe_note_id(id)
        .map_err(|_| CliError::invalid_argument(tf("cli.errors.invalidId", &[("id", id)])))
}

/// The engine's projection of a committed mutation, never reconstructed here.
pub fn mutation_json(mutation: &MutationResult) -> Value {
    json!({
        "id": mutation.final_id,
        "renamed": mutation
            .renamed
            .iter()
            .map(|pair| json!({"from": pair.from, "to": pair.to}))
            .collect::<Vec<_>>(),
        "relinked": mutation.relinked,
    })
}
