//! Where the desktop instance journal lives, and who gets to write to it.
//!
//! The journal itself is `futo_notes_core::journal`. This module only resolves
//! its directory and hands the handle to the one long-lived owner that records
//! today, the sync session on `AppState`.

use std::path::PathBuf;

use futo_notes_core::journal::{Journal, JournalLimits};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::application_state::AppState;

/// The marker every other event in the ring is read against. A `sync_run`
/// record says how long its cycle took; only a launch marker can answer "how
/// long after opening the app did the first one start", and the ring spans many
/// runs of possibly different builds, so a reader also needs to know where one
/// session ends and the next begins.
pub(crate) const APP_LAUNCH_EVENT: &str = "app_launch";

#[derive(Serialize)]
struct AppLaunchRecord<'a> {
    version: &'a str,
    identifier: &'a str,
}

/// Writes the launch marker. Called from `setup` the moment the journal opens —
/// before the webview is created, so its `ts` is this process's own start to
/// within a few milliseconds, which is the anchor `just journal startup` reports
/// the first sync run against.
fn record_launch(journal: &Journal, version: &str, identifier: &str) {
    journal.record(
        APP_LAUNCH_EVENT,
        &AppLaunchRecord {
            version,
            identifier,
        },
    );
}

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
            record_launch(
                &journal,
                &app.package_info().version.to_string(),
                &app.config().identifier,
            );
            let state: State<'_, AppState> = app.state();
            state.sync.set_journal(journal);
            println!("[journal] recording to {}", directory.display());
        }
        Err(error) => eprintln!("[journal] disabled: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futo_notes_core::journal::read_events;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-launch-journal-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// The launch marker is what makes "how long after launch did sync start"
    /// answerable at all, so it has to carry a timestamp and name the build that
    /// wrote it.
    #[test]
    fn a_launch_records_a_timestamped_marker_naming_the_build() {
        let directory = temp_dir();
        let journal = Journal::open(&directory, JournalLimits::default()).unwrap();

        record_launch(&journal, "1.2.3", "com.futo.notes.dev");
        drop(journal);

        let events = read_events(&directory).unwrap();
        fs::remove_dir_all(&directory).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, APP_LAUNCH_EVENT);
        assert!(events[0].recorded_at_ms > 0);
        assert_eq!(events[0].data["version"], "1.2.3");
        assert_eq!(events[0].data["identifier"], "com.futo.notes.dev");
    }

    /// A journal that could not be opened must still cost nothing: the app has
    /// to start (M1), and the disabled sink is the path an unwritable data dir
    /// takes.
    #[test]
    fn a_disabled_journal_records_no_launch_marker() {
        record_launch(&Journal::disabled(), "1.2.3", "com.futo.notes");
    }
}
