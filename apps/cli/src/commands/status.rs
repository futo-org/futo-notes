//! `status`: what the CLI is configured to do. No network, no lock.

use serde_json::json;

use super::Context;
use crate::config;
use crate::error::CliResult;
use crate::i18n::{t, tf};
use crate::output::{display, stdout_line};

pub fn run(ctx: &Context) -> CliResult<()> {
    let config = config::load()?;
    let vault = ctx.vault.clone().or(config.vault.clone());
    let has_command = config.password_command.is_some();
    ctx.out.success(
        json!({
            "vault": vault,
            "server": config.server,
            "passwordCommand": has_command,
        }),
        || {
            let vault = vault.as_ref().map_or_else(
                || t("cli.status.noVault"),
                |path| path.display().to_string(),
            );
            let server = config
                .server
                .clone()
                .unwrap_or_else(|| t("cli.status.localOnly"));
            let command = if has_command {
                t("cli.status.passwordCommandSet")
            } else {
                t("cli.status.passwordCommandUnset")
            };
            stdout_line(&display(&tf("cli.status.vault", &[("path", &vault)])));
            stdout_line(&display(&tf("cli.status.server", &[("server", &server)])));
            stdout_line(&command);
        },
    );
    Ok(())
}
