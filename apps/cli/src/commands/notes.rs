//! Local note commands: list, read, search, create, append, rename, move.
//!
//! None needs an account or the network. Every mutation is one
//! `LocalNoteStore` workflow, so collision allocation and backlink rewriting
//! are the engine's, and the printed IDs are the engine's final ones.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use futo_notes_model::{make_id, split_id};
use futo_notes_store::MutationResult;
use serde_json::json;

use super::{check_id, mutation_json, Context};
use crate::config;
use crate::error::{CliError, CliResult};
use crate::i18n::{t, tf};
use crate::lock::vault_digest;
use crate::output::{display_inline, stdout_bytes, stdout_line};

pub const DEFAULT_SEARCH_LIMIT: u64 = 20;
/// How long `search` waits for the index to finish reconciling with the vault.
const SEARCH_READY_BUDGET: Duration = Duration::from_secs(60);

pub fn list(ctx: &Context, folder: Option<&str>, limit: Option<u64>) -> CliResult<()> {
    let vault = ctx.open()?;
    let notes = vault
        .store
        .snapshot()
        .notes
        .into_iter()
        .filter(|note| folder.is_none_or(|folder| note.folder == folder))
        .take(limit.map_or(usize::MAX, |limit| limit as usize))
        .collect::<Vec<_>>();
    let data = json!({
        "notes": notes
            .iter()
            .map(|note| json!({"id": note.id, "title": note.title, "folder": note.folder}))
            .collect::<Vec<_>>(),
    });
    ctx.out.success(data, || {
        for note in &notes {
            stdout_line(&display_inline(&note.id));
        }
    });
    Ok(())
}

pub fn read(ctx: &Context, id: &str) -> CliResult<()> {
    check_id(id)?;
    let vault = ctx.open()?;
    let content = vault
        .store
        .read_existing(id)
        .map_err(|error| CliError::from_store(id, error))?
        .ok_or_else(|| CliError::note_not_found(id))?;
    ctx.out.success(json!({"id": id, "content": content}), || {
        stdout_bytes(content.as_bytes())
    });
    Ok(())
}

pub fn search(ctx: &Context, query: &str, limit: Option<u64>) -> CliResult<()> {
    let vault = ctx.open()?;
    // Outside the vault, keyed by its canonical path, and safe to delete.
    let index_dir = config::cache_dir()?
        .join("search")
        .join(vault_digest(&vault.root));
    std::fs::create_dir_all(&index_dir).map_err(CliError::io)?;
    let unavailable =
        |detail: String| CliError::io(tf("cli.errors.searchUnavailable", &[("detail", &detail)]));
    vault
        .store
        .start_search(index_dir.join("index"), Arc::new(|_| {}))
        .map_err(unavailable)?;
    if !vault
        .store
        .wait_until_search_ready(SEARCH_READY_BUDGET.as_millis() as u64)
    {
        return Err(CliError::io(t("cli.errors.searchTimeout")));
    }
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT) as usize;
    let hits = vault
        .store
        .search(query, Some(limit))
        .map_err(unavailable)?;
    let data = json!({
        "notes": hits.iter().map(|hit| {
            let (folder, title) = split_id(&hit.note_id);
            json!({"id": hit.note_id, "title": title, "folder": folder})
        }).collect::<Vec<_>>(),
    });
    ctx.out.success(data, || {
        for hit in &hits {
            stdout_line(&display_inline(&hit.note_id));
        }
    });
    Ok(())
}

/// `--body TEXT` or `--stdin` through end of input; the grammar allows exactly
/// one. Invalid UTF-8 fails here, before anything is written.
pub fn body(text: Option<&String>, stdin: bool) -> CliResult<String> {
    if let Some(text) = text {
        return Ok(text.clone());
    }
    debug_assert!(stdin);
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(CliError::io)?;
    String::from_utf8(bytes).map_err(|_| CliError::invalid_argument(t("cli.errors.invalidUtf8")))
}

pub fn create(ctx: &Context, id: &str, content: &str) -> CliResult<()> {
    check_id(id)?;
    let vault = ctx.open()?;
    let (folder, title) = split_id(id);
    let mutation = vault
        .store
        .create(&folder, &title, content)
        .map_err(|error| CliError::from_store(id, error))?;
    report(ctx, &mutation)
}

pub fn append(ctx: &Context, id: &str, content: &str) -> CliResult<()> {
    check_id(id)?;
    let vault = ctx.open()?;
    let mutation = vault
        .store
        .append(id, content)
        .map_err(|error| CliError::from_store(id, error))?;
    report(ctx, &mutation)
}

pub fn rename(ctx: &Context, id: &str, title: &str) -> CliResult<()> {
    check_id(id)?;
    if title.trim().is_empty() {
        return Err(CliError::invalid_argument(t("cli.errors.emptyTitle")));
    }
    let vault = ctx.open()?;
    if !vault.store.exists(id) {
        return Err(CliError::note_not_found(id));
    }
    let (folder, _) = split_id(id);
    let mutation = vault
        .store
        .rename(id, &make_id(&folder, title))
        .map_err(|error| CliError::from_store(id, error))?;
    report(ctx, &mutation)
}

pub fn move_note(ctx: &Context, id: &str, folder: &str) -> CliResult<()> {
    check_id(id)?;
    if !folder.is_empty() {
        futo_notes_core::files::ensure_safe_note_id(folder).map_err(|_| {
            CliError::invalid_argument(tf("cli.errors.invalidFolder", &[("folder", folder)]))
        })?;
    }
    let vault = ctx.open()?;
    if !vault.store.exists(id) {
        return Err(CliError::note_not_found(id));
    }
    let mutation = vault
        .store
        .move_note(id, folder)
        .map_err(|error| CliError::from_store(id, error))?;
    report(ctx, &mutation)
}

fn report(ctx: &Context, mutation: &MutationResult) -> CliResult<()> {
    for warning in &mutation.warnings {
        ctx.out.note(warning);
    }
    let id = mutation.final_id.clone().unwrap_or_default();
    ctx.out.success(mutation_json(mutation), || {
        stdout_line(&display_inline(&id))
    });
    Ok(())
}
