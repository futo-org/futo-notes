//! Where the desktop instance journal lives, and who gets to write to it.
//!
//! The journal itself is `futo_notes_core::journal`. This module only resolves
//! its directory and hands the handle to the one long-lived owner that records
//! today, the sync session on `AppState`.

use std::path::PathBuf;

use futo_notes_core::journal::{Journal, JournalLimits};
use tauri::{AppHandle, Manager, State};

use crate::application_state::AppState;

/// The journal directory for this build. It is derived from the app data dir —
/// `~/.local/share/com.futo.notes(.dev)/journal` on Linux — so the dev/release
/// split comes from the bundle identifier for free and no fourth copy of the
/// notes-root rule is introduced (AGENTS.md M3). `FUTO_NOTES_DATA_DIR` wins, so
/// a worktree dev run journals into its own sandbox.
///
/// It is deliberately NOT under the vault: journal files must never sync and
/// must never appear in the note list.
fn journal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = crate::vault_location::environment_data_dir().map_or_else(
        || app.path().app_data_dir().map_err(|error| error.to_string()),
        Ok,
    )?;
    Ok(base.join("journal"))
}

/// Opens the journal and points the sync session at it. Called from `setup`;
/// a journal that cannot be opened is reported and skipped, because losing
/// diagnostics must never stop the app from starting (M1).
pub(crate) fn install(app: &AppHandle) {
    let opened = journal_dir(app).and_then(|directory| {
        Journal::open(&directory, JournalLimits::default()).map(|journal| (directory, journal))
    });
    match opened {
        Ok((directory, journal)) => {
            let state: State<'_, AppState> = app.state();
            state.sync.set_journal(journal);
            println!("[journal] recording to {}", directory.display());
        }
        Err(error) => eprintln!("[journal] disabled: {error}"),
    }
}
