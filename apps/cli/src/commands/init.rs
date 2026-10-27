//! `init PATH`: configure the CLI's one vault.
//!
//! Creates a missing directory, never touches an existing one's contents, and
//! contacts no server. Re-running on the configured vault changes nothing;
//! pointing at a different directory clears the server and password command,
//! so the new directory never syncs into the account before `auth login`.

use std::path::Path;

use serde_json::json;

use super::Context;
use crate::config;
use crate::error::CliResult;
use crate::output::{display, stdout_line};
use crate::vault;

pub fn run(ctx: &Context, path: &Path) -> CliResult<()> {
    let mut config = config::load()?;
    let root = vault::create_root(path)?;
    let changed = config.vault.as_deref() != Some(root.as_path());
    if changed {
        config.vault = Some(root.clone());
        config.server = None;
        config.password_command = None;
        config::save(&config)?;
    }
    ctx.out
        .success(json!({"vault": root, "changed": changed}), || {
            stdout_line(&display(&root.display().to_string()))
        });
    Ok(())
}
