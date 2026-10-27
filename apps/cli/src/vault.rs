//! Which vault a command acts on: the global `--vault PATH` for one command,
//! else the configured one. The working directory never selects a vault and a
//! GUI app's vault is never discovered. Only `init` creates a vault directory.

use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::error::{CliError, CliResult, Code};
use crate::i18n::{t, tf};

pub fn select(config: &Config, explicit: Option<&Path>) -> CliResult<PathBuf> {
    let root = match explicit {
        Some(path) => std::fs::canonicalize(path).map_err(|_| missing(path))?,
        None => config
            .vault
            .clone()
            .ok_or_else(|| CliError::new(Code::VaultNotConfigured, t("cli.errors.noVault")))?,
    };
    if !root.is_dir() {
        return Err(missing(&root));
    }
    Ok(root)
}

/// Sync and sign-in act only on the configured vault: syncing any other
/// directory would merge it into the account `init` cleared it away from.
pub fn select_configured(config: &Config, explicit: Option<&Path>) -> CliResult<PathBuf> {
    let root = select(config, explicit)?;
    if config.vault.as_deref() != Some(root.as_path()) {
        return Err(CliError::invalid_argument(tf(
            "cli.errors.syncOtherVault",
            &[("path", &root.display().to_string())],
        )));
    }
    Ok(root)
}

fn missing(path: &Path) -> CliError {
    CliError::new(
        Code::VaultMissing,
        tf(
            "cli.errors.vaultMissing",
            &[("path", &path.display().to_string())],
        ),
    )
}

/// `init`'s directory step: create it if missing, then canonicalize.
pub fn create_root(path: &Path) -> CliResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(CliError::invalid_argument(t("cli.errors.emptyPath")));
    }
    if path.exists() && !path.is_dir() {
        return Err(CliError::invalid_argument(tf(
            "cli.errors.notADirectory",
            &[("path", &path.display().to_string())],
        )));
    }
    std::fs::create_dir_all(path).map_err(CliError::io)?;
    std::fs::canonicalize(path).map_err(CliError::io)
}
