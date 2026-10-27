//! `edit`: an external editor over a private draft, saved through the store's
//! one save verb.
//!
//! The note's body at open time is the draft's base. The editor runs on a
//! temporary file outside the vault with no lock held. The save is
//! `flush_draft` with that base: a change made meanwhile parks the draft as an
//! engine-named conflict copy instead of being overwritten.

use std::path::{Path, PathBuf};
use std::process::Command;

use futo_notes_model::split_id;
use futo_notes_store::FlushDisposition;
use serde_json::json;

use super::{check_id, mutation_json, Context};
use crate::error::{CliError, CliResult, Code};
use crate::i18n::{t, tf};
use crate::output::{display_inline, stdout_line};

pub fn run(ctx: &Context, id: &str) -> CliResult<()> {
    check_id(id)?;
    let (program, args) = editor_command()?;
    let base = {
        let vault = ctx.open()?;
        vault
            .store
            .read_existing(id)
            .map_err(|error| CliError::from_store(id, error))?
            .ok_or_else(|| CliError::note_not_found(id))?
    };

    let draft_dir = private_draft_dir()?;
    let (_, title) = split_id(id);
    let draft_path = draft_dir.join(format!("{title}.md"));
    std::fs::write(&draft_path, base.as_bytes()).map_err(CliError::io)?;
    let kept = |code: Code, path: &str| {
        CliError::new(
            code,
            tf(path, &[("path", &draft_path.display().to_string())]),
        )
        .with_data(json!({"id": id, "draftPath": draft_path}))
    };

    let mut editor = Command::new(&program);
    editor.args(&args).arg(&draft_path);
    if ctx.out.is_json() {
        // stdout carries exactly one JSON object; the editor's output goes to
        // stderr instead.
        if let Some(stderr) = stderr_handle() {
            editor.stdout(stderr);
        }
    }
    match editor.status() {
        Ok(status) if status.success() => {}
        Ok(_) => return Err(kept(Code::IoError, "cli.errors.editorExited")),
        Err(_) => return Err(kept(Code::IoError, "cli.errors.editorStart")),
    }

    let draft = String::from_utf8(std::fs::read(&draft_path).map_err(CliError::io)?)
        .map_err(|_| kept(Code::InvalidArgument, "cli.errors.draftInvalidUtf8"))?;
    if draft == base {
        remove_draft(&draft_dir, &draft_path);
        ctx.out
            .success(json!({"id": id, "disposition": "unchanged"}), || {
                ctx.out.note(&t("cli.edit.unchanged"))
            });
        return Ok(());
    }

    let saved = ctx
        .open()
        .and_then(|vault| {
            vault
                .store
                .flush_draft(id, &base, &draft)
                .map_err(CliError::io)
        })
        .map_err(|error| {
            let mut failure = kept(error.code, "cli.errors.editSaveFailed");
            if error.code == Code::VaultBusy {
                failure.message = format!("{} {}", error.message, failure.message);
            }
            failure
        })?;
    remove_draft(&draft_dir, &draft_path);
    if let Some(mutation) = &saved.mutation {
        for warning in &mutation.warnings {
            ctx.out.note(warning);
        }
    }
    let mutation = saved.mutation.as_ref().map(mutation_json);
    let disposition = match saved.disposition {
        FlushDisposition::ParkedConflict { parked_id } => {
            return Err(CliError::new(
                Code::DraftParked,
                tf("cli.edit.parked", &[("id", id), ("parkedId", &parked_id)]),
            )
            .with_data(json!({
                "id": id,
                "disposition": "parkedConflict",
                "parkedId": parked_id,
                "mutation": mutation,
            })));
        }
        FlushDisposition::Wrote => "wrote",
        FlushDisposition::Converged => "converged",
        FlushDisposition::Recreated => "recreated",
    };
    ctx.out.success(
        json!({"id": id, "disposition": disposition, "mutation": mutation}),
        || stdout_line(&display_inline(id)),
    );
    Ok(())
}

fn stderr_handle() -> Option<std::process::Stdio> {
    use std::os::fd::AsFd;
    std::io::stderr()
        .as_fd()
        .try_clone_to_owned()
        .ok()
        .map(std::process::Stdio::from)
}

/// `VISUAL`, then `EDITOR`, split into words without any shell; the draft
/// path is appended as one argument.
fn editor_command() -> CliResult<(String, Vec<String>)> {
    let configured = ["VISUAL", "EDITOR"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::invalid_argument(t("cli.errors.editorNotConfigured")))?;
    let mut words = shlex::split(&configured)
        .filter(|words| !words.is_empty())
        .ok_or_else(|| CliError::invalid_argument(t("cli.errors.editorUnparseable")))?;
    let program = words.remove(0);
    Ok((program, words))
}

/// A fresh directory only this user can read, outside every vault.
fn private_draft_dir() -> CliResult<PathBuf> {
    use std::os::unix::fs::DirBuilderExt;
    let base = std::env::temp_dir();
    for attempt in 0..100u32 {
        let candidate = base.join(format!(
            "futo-notes-edit-{}-{}-{attempt}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        match std::fs::DirBuilder::new().mode(0o700).create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(CliError::io(error)),
        }
    }
    Err(CliError::io("could not create a private draft directory"))
}

/// Removes only what this invocation created: the draft and its directory.
fn remove_draft(dir: &Path, draft: &Path) {
    let _ = std::fs::remove_file(draft);
    let _ = std::fs::remove_dir(dir);
}
