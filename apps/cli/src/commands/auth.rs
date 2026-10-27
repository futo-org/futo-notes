//! `auth login` and `auth logout`, password mode only.
//!
//! Sign-in, collection choice, key derivation, and checkpoints are all
//! `SyncSession`'s. The CLI records only the server and the password command.

use futo_notes_sync::SyncSession;
use serde_json::json;

use super::{sync, Context};
use crate::config;
use crate::error::{CliError, CliResult};
use crate::i18n::{t, tf};
use crate::output::stdout_line;
use crate::password;
use crate::vault;

pub async fn login(ctx: &Context, server: &str, password_command: Option<&str>) -> CliResult<()> {
    let mut config = config::load()?;
    let root = vault::select_configured(&config, ctx.vault.as_deref())?;
    if !(server.starts_with("http://") || server.starts_with("https://")) {
        return Err(CliError::invalid_argument(tf(
            "cli.errors.serverUrl",
            &[("server", server)],
        )));
    }
    if let Some(current) = config.server.as_deref() {
        if !same_server(current, server) {
            return Err(CliError::invalid_argument(tf(
                "cli.errors.otherServer",
                &[("server", current)],
            )));
        }
    }
    if password_command.is_some_and(|command| password::split_command(command).is_none()) {
        return Err(CliError::invalid_argument(t(
            "cli.errors.passwordCommandParse",
        )));
    }
    let password = password::obtain(password_command, ctx.out.is_json())?;
    let vault = ctx.open_root(root)?;
    let session = SyncSession::new();
    sync::connect(&session, &vault.root, server, &password).await?;

    // Signed in: keep the configuration even if the first sync fails, so a
    // plain `sync` can retry it.
    config.server = Some(server.to_owned());
    config.password_command = password_command.map(str::to_owned);
    config::save(&config)?;
    ctx.out
        .note(&tf("cli.auth.signedIn", &[("server", server)]));

    let summary = sync::cycle(ctx, &session, &vault.root)
        .await
        .map_err(|mut error| {
            error.message = tf("cli.errors.firstSyncFailed", &[("detail", &error.message)]);
            error
        })?;
    sync::report(ctx, &summary);
    Ok(())
}

pub async fn logout(ctx: &Context) -> CliResult<()> {
    let mut config = config::load()?;
    let root = vault::select_configured(&config, ctx.vault.as_deref())?;
    {
        let vault = ctx.open_root(root)?;
        // Keeps the ancestry records later syncs need; never deletes a note
        // here or anything on the server.
        SyncSession::new()
            .disconnect(&vault.root)
            .await
            .map_err(|error| CliError::io(error.message()))?;
    }
    config.server = None;
    config.password_command = None;
    config::save(&config)?;
    ctx.out
        .success(json!({}), || stdout_line(&t("cli.auth.signedOut")));
    Ok(())
}

fn same_server(left: &str, right: &str) -> bool {
    left.trim().trim_end_matches('/') == right.trim().trim_end_matches('/')
}
