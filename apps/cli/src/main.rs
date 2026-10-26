//! `futo-notes`: a terminal client for one Markdown vault on a headless Linux
//! machine, syncing with a self-hosted server in password mode.
//!
//! Orchestration only: parse, load configuration, take the vault lock, call
//! the store or `SyncSession`, print the result. Note rules live in
//! `futo-notes-store`, sync in `futo-notes-sync`.

mod cli;
mod commands;
mod config;
mod error;
mod i18n;
mod lock;
mod output;
mod password;
mod vault;

use std::path::PathBuf;

use clap::error::ErrorKind;
use clap::ArgMatches;

use commands::Context;
use error::{CliError, CliResult};
use i18n::{t, tf};
use output::Output;

fn main() {
    restore_default_sigpipe();
    std::process::exit(run());
}

/// Rust ignores SIGPIPE, which would make `futo-notes list | head -1` fail on
/// its next write. A command-line tool should simply stop, like every other.
fn restore_default_sigpipe() {
    // SAFETY: called once at startup, before any other thread exists.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

fn run() -> i32 {
    let matches = match cli::command().try_get_matches() {
        Ok(matches) => matches,
        Err(error) => return argument_error(error),
    };
    let ctx = Context {
        out: Output::new(matches.get_flag("json")),
        vault: matches.get_one::<PathBuf>("vault").cloned(),
    };
    match dispatch(&ctx, &matches) {
        Ok(()) => 0,
        Err(error) => {
            ctx.out.failure(&error);
            error.code.exit_status()
        }
    }
}

fn argument_error(error: clap::Error) -> i32 {
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        let _ = error.print();
        return 0;
    }
    let rendered = error.render().to_string();
    let detail = rendered
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches("error: ")
        .to_owned();
    let failure = CliError::invalid_argument(tf("cli.errors.arguments", &[("detail", &detail)]));
    if std::env::args().any(|arg| arg == "--json") {
        Output::new(true).failure(&failure);
    } else {
        let _ = error.print();
    }
    failure.code.exit_status()
}

fn runtime() -> CliResult<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(CliError::io)
}

fn string<'a>(matches: &'a ArgMatches, name: &str) -> &'a str {
    matches
        .get_one::<String>(name)
        .map(String::as_str)
        .unwrap_or("")
}

fn dispatch(ctx: &Context, matches: &ArgMatches) -> CliResult<()> {
    let no_command = || CliError::invalid_argument(t("cli.errors.noCommand"));
    let (name, sub) = matches.subcommand().ok_or_else(no_command)?;
    match name {
        "init" => commands::init::run(ctx, sub.get_one::<PathBuf>("path").expect("required")),
        "status" => commands::status::run(ctx),
        "list" => commands::notes::list(
            ctx,
            sub.get_one::<String>("folder").map(String::as_str),
            sub.get_one::<u64>("limit").copied(),
        ),
        "read" => commands::notes::read(ctx, string(sub, "id")),
        "search" => commands::notes::search(
            ctx,
            string(sub, "query"),
            sub.get_one::<u64>("limit").copied(),
        ),
        "create" => {
            let body = commands::notes::body(sub.get_one::<String>("body"), sub.get_flag("stdin"))?;
            commands::notes::create(ctx, string(sub, "id"), &body)
        }
        "append" => {
            let body = commands::notes::body(sub.get_one::<String>("body"), sub.get_flag("stdin"))?;
            commands::notes::append(ctx, string(sub, "id"), &body)
        }
        "edit" => commands::edit::run(ctx, string(sub, "id")),
        "rename" => commands::notes::rename(ctx, string(sub, "id"), string(sub, "title")),
        "move" => commands::notes::move_note(ctx, string(sub, "id"), string(sub, "folder")),
        "sync" => runtime()?.block_on(commands::sync::run(ctx)),
        "auth" => match sub.subcommand().ok_or_else(no_command)? {
            ("login", args) => runtime()?.block_on(commands::auth::login(
                ctx,
                string(args, "server"),
                args.get_one::<String>("password-command")
                    .map(String::as_str),
            )),
            ("logout", _) => runtime()?.block_on(commands::auth::logout(ctx)),
            _ => Err(no_command()),
        },
        _ => Err(no_command()),
    }
}
