//! `sync`: get the password, connect, run exactly one `SyncSession` cycle, exit.
//!
//! Every protocol decision is the engine's; this file only decides what an
//! outcome means for the exit status. No session token survives the run.

use std::path::Path;

use futo_notes_sync::{SyncErrorKind, SyncSession, SyncSummary};
use serde_json::{json, Value};

use super::Context;
use crate::config;
use crate::error::{CliError, CliResult, Code};
use crate::i18n::{t, tf};
use crate::output::stdout_line;
use crate::password;
use crate::vault;

pub async fn run(ctx: &Context) -> CliResult<()> {
    let config = config::load()?;
    let root = vault::select_configured(&config, ctx.vault.as_deref())?;
    let server = config
        .server
        .clone()
        .ok_or_else(|| CliError::new(Code::AuthFailed, t("cli.errors.notSignedIn")))?;
    let password = password::obtain(config.password_command.as_deref(), ctx.out.is_json())?;
    let vault = ctx.open_root(root)?;
    let session = SyncSession::new();
    connect(&session, &vault.root, &server, &password).await?;
    let summary = cycle(ctx, &session, &vault.root).await?;
    report(ctx, &summary);
    Ok(())
}

pub async fn connect(
    session: &SyncSession,
    root: &Path,
    server: &str,
    password: &str,
) -> CliResult<()> {
    session
        .connect(root, server, password)
        .await
        .map(|_| ())
        .map_err(connect_error)
}

/// One cycle, stopped by Ctrl-C or SIGTERM. The cycle writes its checkpoint
/// atomically and synchronously, so stopping at an await never leaves one
/// half-written; the next `sync` resumes from the last one saved.
pub async fn cycle(ctx: &Context, session: &SyncSession, root: &Path) -> CliResult<SyncSummary> {
    ctx.out.note(&t("cli.sync.running"));
    let progress = |_: futo_notes_sync::SyncProgress| {};
    let pre_write = |_: &str| {};
    let outcome = tokio::select! {
        outcome = session.sync(root, &progress, &pre_write) => outcome,
        () = shutdown_signal() => {
            return Err(CliError::new(Code::SyncIncomplete, t("cli.errors.interrupted")));
        }
    };
    classify(outcome.map_err(cycle_error)?)
}

pub fn report(ctx: &Context, summary: &SyncSummary) {
    if summary.conflicts > 0 {
        ctx.out.note(&tf(
            "cli.sync.conflicts",
            &[("count", &summary.conflicts.to_string())],
        ));
    }
    ctx.out.success(summary_json(summary), || {
        stdout_line(&tf(
            "cli.sync.summary",
            &[
                ("uploaded", &summary.uploaded.to_string()),
                ("downloaded", &summary.downloaded.to_string()),
                ("deleted", &summary.deleted.to_string()),
            ],
        ))
    });
}

/// A clean cycle is success. Per-item failures (a checkpoint write failure is
/// one), a write refusal, or anything left untransferred is not, and carries
/// the counts so the committed work is still reported. Conflict copies are a
/// resolution, not a failure.
fn classify(summary: SyncSummary) -> CliResult<SyncSummary> {
    if summary.failures.is_empty() && summary.write_refusal.is_none() {
        return Ok(summary);
    }
    let message = summary
        .failure_message()
        .map(|detail| tf("cli.errors.syncIncompleteDetail", &[("detail", &detail)]))
        .unwrap_or_else(|| t("cli.errors.syncIncomplete"));
    Err(CliError::new(Code::SyncIncomplete, message).with_data(summary_json(&summary)))
}

/// The engine's counts and classified failures. Never a token or a key.
fn summary_json(summary: &SyncSummary) -> Value {
    json!({
        "uploaded": summary.uploaded,
        "downloaded": summary.downloaded,
        "deleted": summary.deleted,
        "conflicts": summary.conflicts,
        "failures": summary
            .failures
            .iter()
            .map(|failure| json!({"filename": failure.filename, "kind": failure.kind.as_str()}))
            .collect::<Vec<_>>(),
        "writeRefusal": summary.write_refusal.map(|refusal| refusal.as_str()),
    })
}

/// Sign-in failures. Wrong passwords and unreachable servers get distinct codes.
fn connect_error(error: SyncErrorKind) -> CliError {
    match error {
        SyncErrorKind::Auth(_) | SyncErrorKind::Crypto(_) => {
            CliError::new(Code::AuthFailed, t("cli.errors.authRejected"))
        }
        SyncErrorKind::Http(detail) => network_error(&detail),
        SyncErrorKind::VaultMissing(path) => CliError::new(
            Code::VaultMissing,
            tf("cli.errors.vaultMissing", &[("path", &path)]),
        ),
        // Connecting saves the sync checkpoint before anything else; failing
        // to write it means this sync did not happen.
        SyncErrorKind::Io(detail) => CliError::new(
            Code::SyncIncomplete,
            tf("cli.errors.syncIncompleteDetail", &[("detail", &detail)]),
        ),
        other => CliError::io(other.message()),
    }
}

fn cycle_error(error: SyncErrorKind) -> CliError {
    match error {
        SyncErrorKind::Auth(_) => CliError::new(Code::AuthFailed, t("cli.errors.authRejected")),
        SyncErrorKind::Http(detail) => network_error(&detail),
        SyncErrorKind::VaultMissing(path) => CliError::new(
            Code::VaultMissing,
            tf("cli.errors.vaultMissing", &[("path", &path)]),
        ),
        other => CliError::new(
            Code::SyncIncomplete,
            tf(
                "cli.errors.syncIncompleteDetail",
                &[("detail", &other.message())],
            ),
        ),
    }
}

fn network_error(detail: &str) -> CliError {
    CliError::new(
        Code::NetworkError,
        tf("cli.errors.network", &[("detail", detail)]),
    )
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}
