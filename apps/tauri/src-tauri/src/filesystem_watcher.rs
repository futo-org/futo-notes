//! Vault filesystem watcher and self-write event suppression.
//!
//! Commands mutate the vault optimistically from the frontend. Before a Rust
//! mutation touches disk it registers the affected relative paths here; the
//! corresponding `notify` echo is consumed exactly once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{
    event::{MetadataKind, ModifyKind, RenameMode},
    Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher,
};
use tauri::{AppHandle, Emitter, Manager, State};

use futo_notes_core::files::{note_id_from_relative_path, vault_fs};

use crate::application_state::AppState;
use crate::background_tasks::blocking;

mod classify;
mod event_processor;
mod sink;

use classify::{classify, path_exists, relative_note_path_any, ChangeKind};
use event_processor::{EventProcessor, PendingRename};
use sink::{ChangeSink, EventSink};

/// Must stay LONGER than `POLL_INTERVAL_MS`: suppression hides the app's own
/// write from the watcher, and under polling that write is only observed on the
/// next pass — up to one full interval later — so a shorter window would re-ingest
/// every save as an external edit. The cost of the ordering is the
/// swallowed-concurrent-edit gap in docs/spec/desktop-rust.md, whose window this
/// pair fixes at one poll interval.
const SUPPRESSION_WINDOW_MS: i64 = 5_000;
const RENAME_PAIR_TIMEOUT_MS: i64 = 500;
/// FSEvents and ReadDirectoryChangesW have no rename cookie, but deliver a
/// rename's two names as consecutive entries, microseconds apart. An old name
/// pairs only with a new name that follows it that closely; anything later is
/// a different change.
const RENAME_HALF_GAP_MS: i64 = 100;
/// How often the poll watcher restats the vault. Only reached on filesystems
/// where inotify lies (see `WatchMode::Poll`), so a normal vault never pays it.
/// A stat walk over the document portal measured ~0.095 ms per entry (2,000 notes
/// in 189 ms, against 14 ms on the real filesystem), so this keeps even a
/// 10,000-note vault under a quarter of one background thread while still
/// surfacing an external edit while the user waits.
const POLL_INTERVAL_MS: u64 = 4_000;

/// How the active watcher learns about changes. Not a preference — inotify is
/// used wherever it works, and `portal_vault::inotify_is_unreliable` decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchMode {
    Inotify,
    Poll,
}

#[derive(Clone, Default)]
pub(crate) struct WatcherSuppression {
    entries: Arc<Mutex<HashMap<String, i64>>>,
}

impl WatcherSuppression {
    pub(crate) fn register(&self, relative_path: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            let now = futo_notes_core::files::now_ms();
            entries.insert(relative_path.to_owned(), now + SUPPRESSION_WINDOW_MS);
            entries.retain(|_, expiry| *expiry > now);
        }
    }

    fn consume(&self, relative_path: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let now = futo_notes_core::files::now_ms();
        entries.retain(|_, expiry| *expiry > now);
        entries.remove(relative_path).is_some()
    }

    fn consume_rename(&self, from: &str, to: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let now = futo_notes_core::files::now_ms();
        entries.retain(|_, expiry| *expiry > now);
        if entries.contains_key(from) && entries.contains_key(to) {
            entries.remove(from);
            entries.remove(to);
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, relative_path: &str) -> bool {
        self.entries
            .lock()
            .map(|entries| entries.contains_key(relative_path))
            .unwrap_or(false)
    }
}

#[derive(Default)]
pub(crate) struct WatcherState {
    active: Arc<Mutex<Option<Box<dyn Watcher + Send>>>>,
    pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
    suppression: WatcherSuppression,
}

impl WatcherState {
    pub(crate) fn suppression(&self) -> WatcherSuppression {
        self.suppression.clone()
    }
}

fn watch_bases(root: &Path) -> Vec<PathBuf> {
    let mut bases = Vec::with_capacity(2);
    if let Ok(canonical) = root.canonicalize() {
        bases.push(canonical);
    }
    if !bases.iter().any(|base| base == root) {
        bases.push(root.to_owned());
    }
    bases
}

#[tauri::command]
pub async fn fs_start_watcher(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let active = state.watcher.active.clone();
    let pending_renames = state.watcher.pending_renames.clone();
    let suppression = state.watcher.suppression();
    blocking(move || {
        let mut active = active
            .lock()
            .map_err(|_| "watcher lock poisoned".to_owned())?;
        if active.is_some() {
            return Ok(());
        }

        let root = crate::vault_location::root(&app)?;
        let mode = watch_mode(&root);
        let processor = EventProcessor::new(
            watch_bases(&root),
            pending_renames,
            EventSink { app, suppression },
            mode,
        );
        let handler = move |result: Result<Event, notify::Error>| {
            if let Ok(event) = result {
                processor.process(event);
            }
        };
        let mut watcher: Box<dyn Watcher + Send> = match mode {
            WatchMode::Poll => Box::new(
                PollWatcher::new(
                    handler,
                    Config::default()
                        .with_poll_interval(std::time::Duration::from_millis(POLL_INTERVAL_MS)),
                )
                .map_err(|error| error.to_string())?,
            ),
            WatchMode::Inotify => Box::new(
                RecommendedWatcher::new(handler, Config::default())
                    .map_err(|error| error.to_string())?,
            ),
        };
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        *active = Some(watcher);
        Ok(())
    })
    .await
}

/// A document-portal vault — and any other FUSE passthrough — delivers inotify
/// events only for writes made through the same mount, so an external editor is
/// invisible to it. Polling is the only way to see those edits.
fn watch_mode(root: &Path) -> WatchMode {
    if crate::portal_vault::inotify_is_unreliable(root) {
        WatchMode::Poll
    } else {
        WatchMode::Inotify
    }
}

#[cfg(test)]
mod tests;
