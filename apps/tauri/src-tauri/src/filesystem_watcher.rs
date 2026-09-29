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

use crate::application_state::AppState;
use crate::background_tasks::blocking;

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

#[derive(Clone)]
struct PendingRename {
    from_path: PathBuf,
    inserted_at: i64,
}

/// A cookieless rename's old name, waiting for the entry after its own.
struct OldHalf {
    path: PathBuf,
    entry: u64,
    at: i64,
}

/// What the processor carries between events.
#[derive(Default)]
struct RenameState {
    /// notify reports one backend entry as one event per flag, all with the
    /// entry's path, so a change of path starts the next entry. `entry`
    /// counts them.
    entry_path: Option<PathBuf>,
    entry: u64,
    old_half: Option<OldHalf>,
    /// Note paths a rename emptied, waiting to learn whether the note left
    /// the vault or was written again in place.
    vacated: Vec<PendingRename>,
    flusher_running: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum ChangeKind {
    Add,
    Change,
    Unlink,
    RenameFrom,
    RenameTo,
    /// One half of a rename that does not say which (macOS FSEvents).
    RenameEither,
}

fn classify(event: &Event, mode: WatchMode) -> Option<ChangeKind> {
    match &event.kind {
        EventKind::Create(_) => Some(ChangeKind::Add),
        // The poll backend reports an edited file as a WriteTime metadata change
        // (notify's `poll::compare_to_event`) and reserves `Modify(Data)` for the
        // rarer same-mtime-different-content case. Native backends use WriteTime
        // for chmod/touch noise only, which is why this is mode-dependent: taking
        // it everywhere would make every `touch` a change, and dropping it under
        // poll would make the poll watcher blind to edits — the exact silence this
        // fallback exists to remove.
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime))
            if mode == WatchMode::Poll =>
        {
            Some(ChangeKind::Change)
        }
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(ChangeKind::RenameFrom),
        EventKind::Modify(ModifyKind::Name(RenameMode::To | RenameMode::Both)) => {
            Some(ChangeKind::RenameTo)
        }
        // FSEvents has no rename cookie and does not say which half a path is:
        // notify reports both as `Name(Any)`, one event per path.
        EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => Some(ChangeKind::RenameEither),
        EventKind::Modify(_) => Some(ChangeKind::Change),
        EventKind::Remove(_) => Some(ChangeKind::Unlink),
        _ => None,
    }
}

/// Whether anything is at `path` now, without following a symlink.
fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn relative_note_path(base: &Path, path: &Path) -> Option<String> {
    relative_note_path_stripped(path.strip_prefix(base).ok()?)
}

fn relative_note_path_any(bases: &[PathBuf], path: &Path) -> Option<String> {
    bases.iter().find_map(|base| relative_note_path(base, path))
}

fn relative_note_path_stripped(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    if !path.ends_with(".md") && !path.ends_with(".txt") {
        return None;
    }
    if path
        .split(['/', '\\'])
        .any(|component| component.starts_with('.'))
    {
        return None;
    }
    Some(path.replace('\\', "/"))
}

/// Where the processor reports normalized vault changes: the app's
/// [`EventSink`], or a recorder in tests.
trait ChangeSink: Clone + Send + Sync + 'static {
    fn change(&self, kind: &str, relative_path: &str);
    fn rename(&self, from: &str, to: &str);
}

#[derive(Clone)]
struct EventSink {
    app: AppHandle,
    suppression: WatcherSuppression,
}

impl ChangeSink for EventSink {
    fn change(&self, kind: &str, relative_path: &str) {
        if self.suppression.consume(relative_path) {
            return;
        }
        let change = match kind {
            "unlink" => futo_notes_store::FileChange::Removed(relative_path.to_owned()),
            _ => futo_notes_store::FileChange::Changed(relative_path.to_owned()),
        };
        self.app.state::<AppState>().notes.observe(change);
        let _ = self.app.emit(
            "fs:change",
            serde_json::json!({ "type": kind, "filename": relative_path }),
        );
    }

    fn rename(&self, from: &str, to: &str) {
        if self.suppression.consume_rename(from, to) {
            return;
        }
        self.app
            .state::<AppState>()
            .notes
            .observe(futo_notes_store::FileChange::Renamed {
                from: from.to_owned(),
                to: to.to_owned(),
            });
        let _ = self.app.emit(
            "fs:change",
            serde_json::json!({ "type": "rename", "filename": to, "from": from }),
        );
    }
}

#[derive(Clone)]
struct EventProcessor<S: ChangeSink> {
    bases: Vec<PathBuf>,
    pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
    renames: Arc<Mutex<RenameState>>,
    sink: S,
    mode: WatchMode,
}

impl<S: ChangeSink> EventProcessor<S> {
    fn new(
        bases: Vec<PathBuf>,
        pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
        sink: S,
        mode: WatchMode,
    ) -> Self {
        Self {
            bases,
            pending_renames,
            renames: Arc::default(),
            sink,
            mode,
        }
    }

    /// Runs under the rename-state lock, as does the timer that resolves
    /// what it leaves waiting, so the two report in one order.
    fn process(&self, event: Event) {
        let Ok(mut state) = self.renames.lock() else {
            return;
        };
        let now = futo_notes_core::files::now_ms();
        self.enter_entry(&mut state, event.paths.first(), now);
        let Some(kind) = classify(&event, self.mode) else {
            return;
        };
        self.flush_stale(&mut state, now);
        match kind {
            ChangeKind::RenameFrom => self.rename_from(&mut state, event, now),
            ChangeKind::RenameTo => self.rename_to(&mut state, event, now),
            ChangeKind::RenameEither => self.rename_either(&mut state, event, now),
            // FSEvents coalesces flags per path, so a rename's old name can also
            // carry its earlier create/write after the file is gone. A path that
            // no longer exists was not added or edited: the rename or removal
            // half reports it. Reporting it as an edit made the shell flush the
            // open note's pending save to that id and recreate it there.
            ChangeKind::Add => {
                for path in event.paths {
                    self.present(&mut state, &path, "add");
                }
            }
            ChangeKind::Change => {
                for path in event.paths {
                    self.present(&mut state, &path, "change");
                }
            }
            // Coalescing also leaves a removal on a path that was written again
            // since: a note that exists was not removed.
            ChangeKind::Unlink => {
                for path in event.paths {
                    if path_exists(&path) {
                        self.arrived(&mut state, &path, "change");
                    } else {
                        self.revisit(&mut state, &path);
                        self.emit_path("unlink", &path);
                    }
                }
            }
        }
    }

    /// Count backend entries, and give up on an old name that the entry
    /// straight after its own did not take.
    fn enter_entry(&self, state: &mut RenameState, path: Option<&PathBuf>, now: i64) {
        if state.entry_path.as_ref() != path {
            state.entry_path = path.cloned();
            state.entry += 1;
        }
        let entry = state.entry;
        if let Some(old) = state
            .old_half
            .take_if(|old| entry > old.entry + 1 || now - old.at > RENAME_HALF_GAP_MS)
        {
            self.vacate(state, old.path, old.at);
        }
    }

    /// Resolve what has waited out its window: a cookie rename whose new half
    /// never came, an old name nothing took, and a vacated note path, which
    /// is an edit if something is at the path again and a removal if not.
    fn flush_stale(&self, state: &mut RenameState, now: i64) {
        if let Ok(mut pending) = self.pending_renames.lock() {
            let stale = pending
                .iter()
                .filter_map(|(cookie, rename)| {
                    (now - rename.inserted_at > RENAME_PAIR_TIMEOUT_MS).then_some(*cookie)
                })
                .collect::<Vec<_>>();
            for cookie in stale {
                if let Some(rename) = pending.remove(&cookie) {
                    self.vacate(state, rename.from_path, rename.inserted_at);
                }
            }
        }
        if let Some(old) = state
            .old_half
            .take_if(|old| now - old.at > RENAME_HALF_GAP_MS)
        {
            self.vacate(state, old.path, old.at);
        }
        let (stale, waiting) = std::mem::take(&mut state.vacated)
            .into_iter()
            .partition::<Vec<_>, _>(|vacated| now - vacated.inserted_at > RENAME_PAIR_TIMEOUT_MS);
        state.vacated = waiting;
        for vacated in stale {
            let path = vacated.from_path;
            self.emit_path(
                if path_exists(&path) {
                    "change"
                } else {
                    "unlink"
                },
                &path,
            );
        }
    }

    /// Hold a note path a rename emptied until its window closes. Nothing may
    /// come to flush it, so a timer does.
    fn vacate(&self, state: &mut RenameState, path: PathBuf, at: i64) {
        if relative_note_path_any(&self.bases, &path).is_none() {
            return;
        }
        if !state
            .vacated
            .iter()
            .any(|vacated| vacated.from_path == path)
        {
            state.vacated.push(PendingRename {
                from_path: path,
                inserted_at: at,
            });
        }
        self.ensure_flusher(state);
    }

    /// Forget a waiting old name or vacated path that `path` fills again, and
    /// say whether there was one.
    fn revisit(&self, state: &mut RenameState, path: &Path) -> bool {
        let vacated = state.vacated.len();
        state.vacated.retain(|waiting| waiting.from_path != path);
        let old_half = state.old_half.take_if(|old| old.path == path).is_some();
        old_half || state.vacated.len() != vacated
    }

    /// Report `path` if something is there now.
    fn present(&self, state: &mut RenameState, path: &Path, kind: &str) {
        if path_exists(path) {
            self.arrived(state, path, kind);
        }
    }

    /// Report a name that exists: a note the vault just lost is back, which
    /// is an edit of it whatever `kind` the event had.
    fn arrived(&self, state: &mut RenameState, path: &Path, kind: &str) {
        let back = self.revisit(state, path);
        self.emit_path(if back { "change" } else { kind }, path);
    }

    fn ensure_flusher(&self, state: &mut RenameState) {
        if state.flusher_running {
            return;
        }
        let processor = self.clone();
        let started = crate::background_tasks::spawn("watcher-rename-pairing", move || loop {
            std::thread::sleep(std::time::Duration::from_millis(RENAME_HALF_GAP_MS as u64));
            let Ok(mut state) = processor.renames.lock() else {
                return;
            };
            processor.flush_stale(&mut state, futo_notes_core::files::now_ms());
            let cookies_waiting = processor
                .pending_renames
                .lock()
                .map(|pending| !pending.is_empty())
                .unwrap_or(false);
            if state.old_half.is_none() && state.vacated.is_empty() && !cookies_waiting {
                state.flusher_running = false;
                return;
            }
        });
        state.flusher_running = started.is_ok();
    }

    /// A rename half with no cookie that does not say which it is (FSEvents).
    /// The old name no longer exists; the new one does.
    fn rename_either(&self, state: &mut RenameState, event: Event, now: i64) {
        for path in event.paths {
            if path_exists(&path) {
                self.new_half(state, path, "change");
            } else {
                self.old_half(state, path, now);
            }
        }
    }

    /// Hold a cookieless old name for the entry after its own. Temp files
    /// count too: an atomic save's temp is what its destination pairs with.
    fn old_half(&self, state: &mut RenameState, path: PathBuf, now: i64) {
        if let Some(previous) = state.old_half.take() {
            self.vacate(state, previous.path, previous.at);
        }
        state.old_half = Some(OldHalf {
            path,
            entry: state.entry,
            at: now,
        });
        self.ensure_flusher(state);
    }

    /// Pair a cookieless new name with the old name of the entry just before
    /// it. Without one it keeps its unpaired meaning (`unpaired_kind`).
    fn new_half(&self, state: &mut RenameState, path: PathBuf, unpaired_kind: &str) {
        let entry = state.entry;
        match state
            .old_half
            .take_if(|old| old.entry + 1 == entry && old.path != path)
        {
            Some(old) => self.pair(state, old.path, path, unpaired_kind, old.at),
            None => self.arrived(state, &path, unpaired_kind),
        }
    }

    fn rename_from(&self, state: &mut RenameState, event: Event, now: i64) {
        let mut paths = event.paths.into_iter();
        let first = paths.next();
        if let (Some(cookie), Some(path)) = (event.attrs.tracker(), first.clone()) {
            if let Ok(mut pending) = self.pending_renames.lock() {
                pending.insert(
                    cookie as u128,
                    PendingRename {
                        from_path: path,
                        inserted_at: now,
                    },
                );
            }
            // A note moved out of the vault has no new half and may have no
            // later event to flush it either.
            self.ensure_flusher(state);
            return;
        }
        // No cookie (Windows): wait for the new half instead of reporting a
        // removal and an add.
        for path in first.into_iter().chain(paths) {
            self.old_half(state, path, now);
        }
    }

    fn rename_to(&self, state: &mut RenameState, event: Event, now: i64) {
        let mut paths = event.paths.into_iter();
        let first = paths.next();
        if let (Some(cookie), Some(to)) = (event.attrs.tracker(), first.clone()) {
            let from = self
                .pending_renames
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&(cookie as u128)))
                .map(|rename| rename.from_path);
            if let Some(from) = from {
                self.pair(state, from, to, "add", now);
                return;
            }
        } else if let Some(to) = first {
            self.new_half(state, to, "add");
            for path in paths {
                self.present(state, &path, "add");
            }
            return;
        }
        for path in first.into_iter().chain(paths) {
            self.present(state, &path, "add");
        }
    }

    /// Report the two names of one rename. It is a move only when both are
    /// notes and the old name stayed empty. Renaming a note to a non-note name
    /// (vim's backup before it writes the note again) empties the note's path
    /// for a moment, so that waits out the window like a move out of the vault.
    fn pair(
        &self,
        state: &mut RenameState,
        from: PathBuf,
        to: PathBuf,
        unpaired_kind: &str,
        at: i64,
    ) {
        if from == to {
            self.present(state, &to, "change");
            return;
        }
        match (
            relative_note_path_any(&self.bases, &from),
            relative_note_path_any(&self.bases, &to),
        ) {
            (Some(from_relative), Some(to_relative)) if !path_exists(&from) => {
                self.revisit(state, &to);
                self.sink.rename(&from_relative, &to_relative);
            }
            (Some(_), Some(_)) => {
                self.arrived(state, &from, "change");
                self.arrived(state, &to, unpaired_kind);
            }
            (Some(_), None) => self.vacate(state, from, at),
            (None, Some(_)) => self.arrived(state, &to, unpaired_kind),
            (None, None) => {}
        }
    }

    fn emit_path(&self, kind: &str, path: &Path) {
        if let Some(relative) = relative_note_path_any(&self.bases, path) {
            self.sink.change(kind, &relative);
        }
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
mod tests {
    //! Tests for filesystem watcher event handling and suppression.
    use super::*;

    /// Cross-language constants gate (architecture-hardening.md PKT-7 gate 3).
    /// `tests/conformance/constants.json`'s `watcherSuppressionWindowMs` is
    /// also asserted from `futo-notes-model`'s conformance test (image set,
    /// title length — this crate isn't a dependency of that one) and from
    /// `src/lib/constantsConformance.test.ts` (TS side). Runs under
    /// `cargo test --workspace` (`just test-rust-full`), not the fast
    /// model-only `just test-rust`, because compiling this crate needs
    /// `dist/` to exist (tauri::generate_context!).
    #[test]
    fn suppression_window_matches_cross_language_constant() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/conformance/constants.json")
            .canonicalize()
            .expect("tests/conformance/constants.json must exist");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let json: serde_json::Value = serde_json::from_str(&text).expect("fixture is valid JSON");
        let expected = json["watcherSuppressionWindowMs"]
            .as_i64()
            .expect("watcherSuppressionWindowMs");
        assert_eq!(
            SUPPRESSION_WINDOW_MS, expected,
            "SUPPRESSION_WINDOW_MS drifted from tests/conformance/constants.json"
        );
    }

    #[test]
    fn suppression_is_one_shot() {
        let suppression = WatcherSuppression::default();
        suppression.register("note.md");
        assert!(suppression.consume("note.md"));
        assert!(!suppression.consume("note.md"));
    }

    #[test]
    fn expired_suppression_is_not_consumed() {
        let suppression = WatcherSuppression::default();
        suppression
            .entries
            .lock()
            .unwrap()
            .insert("note.md".to_owned(), 0);
        assert!(!suppression.consume("note.md"));
        assert!(!suppression.contains("note.md"));
    }

    #[test]
    fn rename_consumes_both_paths_atomically() {
        let suppression = WatcherSuppression::default();
        suppression.register("old.md");
        suppression.register("new.md");
        assert!(suppression.consume_rename("old.md", "new.md"));
        assert!(!suppression.consume("old.md"));
        assert!(!suppression.consume("new.md"));
    }

    #[test]
    fn partial_rename_registration_consumes_neither_path() {
        let suppression = WatcherSuppression::default();
        suppression.register("old.md");
        assert!(!suppression.consume_rename("old.md", "new.md"));
        assert!(suppression.contains("old.md"));
    }

    #[test]
    fn paths_are_normalized_and_hidden_paths_are_rejected() {
        assert_eq!(
            relative_note_path_stripped(Path::new("Folder\\note.md")),
            Some("Folder/note.md".to_owned())
        );
        assert_eq!(relative_note_path_stripped(Path::new(".git/note.md")), None);
        assert_eq!(relative_note_path_stripped(Path::new("image.png")), None);
    }

    #[test]
    fn path_resolution_accepts_raw_and_canonical_root_spellings() {
        let raw = PathBuf::from("/var/futo-notes");
        let canonical = PathBuf::from("/private/var/futo-notes");
        let bases = vec![canonical.clone(), raw.clone()];
        assert_eq!(
            relative_note_path_any(&bases, &raw.join("Folder/note.md")),
            Some("Folder/note.md".to_owned())
        );
        assert_eq!(
            relative_note_path_any(&bases, &canonical.join("Folder/note.md")),
            Some("Folder/note.md".to_owned())
        );
    }

    #[test]
    fn events_are_classified_without_metadata_noise() {
        assert_eq!(
            classify(
                &Event::new(EventKind::Create(notify::event::CreateKind::File)),
                WatchMode::Inotify
            ),
            Some(ChangeKind::Add)
        );
        assert_eq!(
            classify(
                &Event::new(EventKind::Modify(ModifyKind::Metadata(
                    notify::event::MetadataKind::Permissions
                ))),
                WatchMode::Inotify
            ),
            None
        );
        assert_eq!(
            classify(
                &Event::new(EventKind::Remove(notify::event::RemoveKind::File)),
                WatchMode::Inotify
            ),
            Some(ChangeKind::Unlink)
        );
    }

    /// The poll backend's only signal for "this file was edited" is a WriteTime
    /// metadata event. Dropping it as noise — which the native-backend rule does —
    /// would leave a polled vault silent about every external edit.
    #[test]
    fn a_polled_write_time_change_is_an_edit_but_native_write_time_is_noise() {
        let write_time = Event::new(EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime,
        )));
        assert_eq!(
            classify(&write_time, WatchMode::Poll),
            Some(ChangeKind::Change)
        );
        assert_eq!(classify(&write_time, WatchMode::Inotify), None);

        // Permission changes stay noise under both backends.
        let permissions = Event::new(EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Permissions,
        )));
        assert_eq!(classify(&permissions, WatchMode::Poll), None);
        assert_eq!(classify(&permissions, WatchMode::Inotify), None);
    }

    /// An ordinary vault must keep using inotify: polling every couple of seconds
    /// is a fallback for filesystems that lie, not a new default.
    #[test]
    fn an_ordinary_vault_is_watched_by_inotify() {
        assert_eq!(watch_mode(&std::env::temp_dir()), WatchMode::Inotify);
    }

    /// The poll backend really does deliver an external edit that inotify would
    /// miss on a doc-portal mount. Uses a real directory (inotify would work here
    /// too) because what is under test is the PollWatcher + `classify` pairing:
    /// notify reports the edit as WriteTime metadata, and this asserts the change
    /// reaches the sink as an edit.
    #[test]
    fn the_poll_backend_reports_an_external_edit() {
        let root = std::env::temp_dir().join(format!(
            "futo-poll-watch-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let note = root.join("note.md");
        std::fs::write(&note, "before").unwrap();

        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorder = seen.clone();
        let mut watcher = PollWatcher::new(
            move |result: Result<Event, notify::Error>| {
                let Ok(event) = result else { return };
                if let Some(kind) = classify(&event, WatchMode::Poll) {
                    if kind == ChangeKind::Change {
                        for path in &event.paths {
                            recorder
                                .lock()
                                .unwrap()
                                .push(path.to_string_lossy().into_owned());
                        }
                    }
                }
            },
            Config::default().with_poll_interval(std::time::Duration::from_millis(100)),
        )
        .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();

        // mtime has one-second granularity on some filesystems, so make the edit
        // unambiguously newer than the initial scan.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        std::fs::write(&note, "after the edit").unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let observed = seen.lock().unwrap().clone();
        drop(watcher);
        std::fs::remove_dir_all(&root).unwrap();

        assert!(
            observed.iter().any(|path| path.ends_with("note.md")),
            "the poll watcher never reported the edit; saw {observed:?}"
        );
    }

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl ChangeSink for Recorder {
        fn change(&self, kind: &str, relative_path: &str) {
            self.0
                .lock()
                .unwrap()
                .push(format!("{kind} {relative_path}"));
        }

        fn rename(&self, from: &str, to: &str) {
            self.0
                .lock()
                .unwrap()
                .push(format!("rename {from} -> {to}"));
        }
    }

    impl Recorder {
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }

        fn wait_for(&self, wanted: &str, timeout: std::time::Duration) -> bool {
            let deadline = std::time::Instant::now() + timeout;
            while std::time::Instant::now() < deadline {
                if self.0.lock().unwrap().iter().any(|seen| seen == wanted) {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            false
        }
    }

    static VAULT_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    fn temp_vault(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "futo-watch-{label}-{}-{}",
            std::process::id(),
            VAULT_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn recording_processor(root: &Path) -> (EventProcessor<Recorder>, Recorder) {
        let recorder = Recorder::default();
        let processor = EventProcessor::new(
            watch_bases(root),
            Arc::default(),
            recorder.clone(),
            WatchMode::Inotify,
        );
        (processor, recorder)
    }

    fn rename_half(mode: RenameMode, path: PathBuf) -> Event {
        Event::new(EventKind::Modify(ModifyKind::Name(mode))).add_path(path)
    }

    /// macOS FSEvents carries no rename cookie: notify reports BOTH halves of a
    /// rename as `Modify(Name(Any))`, one event per path (notify's fsevent.rs).
    /// Reported as two edits, the shell flushed the open note's pending save to
    /// the id it had just left, and the store recreated it there — a ghost that
    /// synced everywhere, holding the typing the renamed note never got. The
    /// half whose path is gone is the old name; the half that exists is the new.
    #[test]
    fn a_cookieless_rename_is_paired_by_which_path_still_exists() {
        let root = temp_vault("pair");
        std::fs::write(root.join("Draft renamed.md"), "draft").unwrap();
        std::fs::write(root.join("Saved.md"), "saved").unwrap();
        let (processor, recorder) = recording_processor(&root);

        processor.process(rename_half(RenameMode::Any, root.join("Draft.md")));
        // FSEvents coalesces flags per path, so an earlier write to the old name
        // can arrive after it is gone. A file that no longer exists has no edit.
        processor.process(
            Event::new(EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content,
            )))
            .add_path(root.join("Draft.md")),
        );
        processor.process(rename_half(RenameMode::Any, root.join("Draft renamed.md")));
        // A new name with no old half — the destination of an atomic save's
        // hidden temp file — stays what it was: an edit of that note.
        processor.process(rename_half(RenameMode::Any, root.join("Saved.md")));

        let seen = recorder.take();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            seen,
            vec!["rename Draft.md -> Draft renamed.md", "change Saved.md"]
        );
    }

    /// Windows (ReadDirectoryChangesW) reports the old then the new name, also
    /// without a cookie; the same arrival-order pairing makes it one rename
    /// instead of a removal and an add.
    #[test]
    fn a_cookieless_old_then_new_name_is_one_rename() {
        let root = temp_vault("from-to");
        std::fs::write(root.join("Moved.md"), "moved").unwrap();
        let (processor, recorder) = recording_processor(&root);

        processor.process(rename_half(RenameMode::From, root.join("Note.md")));
        processor.process(rename_half(RenameMode::To, root.join("Moved.md")));

        let seen = recorder.take();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(seen, vec!["rename Note.md -> Moved.md"]);
    }

    /// An old name whose new half never comes (moved out of the vault — the
    /// Trash is outside it) is a removal, reported once the pair window closes
    /// even when no later event arrives to flush it.
    #[test]
    fn an_unpaired_old_name_is_reported_as_removed_after_the_pair_window() {
        let root = temp_vault("unpaired");
        let (processor, recorder) = recording_processor(&root);

        processor.process(rename_half(RenameMode::Any, root.join("Gone.md")));
        let before_window = recorder.take();
        let removed = recorder.wait_for("unlink Gone.md", std::time::Duration::from_secs(3));

        let seen = recorder.take();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(
            before_window.is_empty(),
            "reported before its pair window closed: {before_window:?}"
        );
        assert!(removed, "never reported as removed; saw {seen:?}");
        assert_eq!(seen, vec!["unlink Gone.md"]);
    }

    /// A note path that a rename emptied and that is written again is an edit
    /// of the note, whether the rewrite is reported (vim: backup rename, new
    /// file) or only found by the recheck when the window closes. So is a
    /// removal FSEvents left on a path that exists again.
    #[test]
    fn a_note_path_a_rename_emptied_is_an_edit_once_it_is_back() {
        let root = temp_vault("back");
        let (processor, recorder) = recording_processor(&root);

        processor.process(rename_half(RenameMode::Any, root.join("note.md")));
        processor.process(rename_half(RenameMode::Any, root.join("note.md~")));
        std::fs::write(root.join("note.md"), "rewritten").unwrap();
        processor.process(
            Event::new(EventKind::Create(notify::event::CreateKind::File))
                .add_path(root.join("note.md")),
        );
        processor.process(
            Event::new(EventKind::Remove(notify::event::RemoveKind::File))
                .add_path(root.join("note.md")),
        );
        let reported = recorder.take();

        processor.process(rename_half(RenameMode::Any, root.join("quiet.md")));
        std::fs::write(root.join("quiet.md"), "rewritten").unwrap();
        let rechecked = recorder.wait_for("change quiet.md", std::time::Duration::from_secs(3));
        std::thread::sleep(std::time::Duration::from_millis(
            RENAME_PAIR_TIMEOUT_MS as u64 + 200,
        ));
        let seen = recorder.take();
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(reported, vec!["change note.md", "change note.md"]);
        assert!(rechecked, "never rechecked; saw {seen:?}");
        assert_eq!(seen, vec!["change quiet.md"]);
    }

    /// The platform's own backend (FSEvents on macOS, inotify on Linux,
    /// ReadDirectoryChangesW on Windows) feeding a recording processor.
    struct NativeWatch {
        _watcher: RecommendedWatcher,
        recorder: Recorder,
        raw: Arc<Mutex<Vec<String>>>,
    }

    impl NativeWatch {
        fn start(root: &Path) -> Self {
            // Let the vault's setup writes age out of the backend's coalescing window.
            std::thread::sleep(std::time::Duration::from_millis(1_000));
            let (processor, recorder) = recording_processor(root);
            let raw = Arc::new(Mutex::new(Vec::<String>::new()));
            let raw_log = raw.clone();
            let mut watcher = RecommendedWatcher::new(
                move |result: Result<Event, notify::Error>| {
                    if let Ok(event) = result {
                        raw_log.lock().unwrap().push(format!(
                            "{:?} {:?} {:?}",
                            event.kind,
                            event
                                .paths
                                .iter()
                                .filter_map(|p| p.file_name())
                                .collect::<Vec<_>>(),
                            event.attrs.tracker()
                        ));
                        processor.process(event);
                    }
                },
                Config::default(),
            )
            .unwrap();
            watcher.watch(root, RecursiveMode::Recursive).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(500));
            recorder.take();
            raw.lock().unwrap().clear();
            Self {
                _watcher: watcher,
                recorder,
                raw,
            }
        }

        /// Everything reported once any pair window the actions opened has
        /// closed, and what the backend sent.
        fn settle(self) -> (Vec<String>, Vec<String>) {
            std::thread::sleep(std::time::Duration::from_millis(
                RENAME_PAIR_TIMEOUT_MS as u64 + 1_000,
            ));
            drop(self._watcher);
            let raw = self.raw.lock().unwrap().clone();
            (self.recorder.take(), raw)
        }
    }

    /// The platform's own backend reports a rename inside the vault as one
    /// rename, never as an edit or a removal of either name (M26: this runs
    /// on each desktop platform's real backend, not only on a synthetic shape).
    #[test]
    fn the_native_backend_reports_a_rename_as_one_rename() {
        let root = temp_vault("native");
        std::fs::write(root.join("Draft.md"), "draft").unwrap();
        let watch = NativeWatch::start(&root);

        std::fs::rename(root.join("Draft.md"), root.join("Draft renamed.md")).unwrap();
        let renamed = watch.recorder.wait_for(
            "rename Draft.md -> Draft renamed.md",
            std::time::Duration::from_secs(5),
        );
        let (seen, raw) = watch.settle();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(
            renamed,
            "no rename reported; sink saw {seen:?}, backend sent {raw:?}"
        );
        assert!(
            !seen
                .iter()
                .any(|entry| entry.starts_with("change ") || entry.starts_with("unlink ")),
            "a rename must not read as an edit or removal; sink saw {seen:?}, backend sent {raw:?}"
        );
    }

    /// vim's default save renames the note to a backup name, writes a new file
    /// at the note's path and deletes the backup, so the path is briefly
    /// missing. That is an edit of a note that never stopped existing: a
    /// removal would drop it from the search index (and close it if open).
    #[test]
    fn a_vim_style_save_never_reports_the_live_note_removed() {
        let root = temp_vault("vim");
        let note = root.join("note.md");
        let backup = root.join("note.md~");
        std::fs::write(&note, "v0").unwrap();
        let watch = NativeWatch::start(&root);

        for round in 0..24u64 {
            std::fs::rename(&note, &backup).unwrap();
            // The gap between the rename and the rewrite decides whether the
            // backend sees the path missing; cover none, short and long.
            std::thread::sleep(std::time::Duration::from_millis(
                [0, 2, 10][round as usize % 3],
            ));
            std::fs::write(&note, format!("v{}", round + 1)).unwrap();
            std::fs::remove_file(&backup).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let (seen, raw) = watch.settle();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(
            !seen
                .iter()
                .any(|entry| entry.starts_with("unlink ") || entry.starts_with("rename ")),
            "a rewrite of note.md read as a removal or rename; sink saw {seen:?}, backend sent {raw:?}"
        );
        assert!(
            seen.iter()
                .any(|entry| entry == "change note.md" || entry == "add note.md"),
            "the rewrite was never reported; sink saw {seen:?}, backend sent {raw:?}"
        );
    }

    /// An atomic save whose temp file has a note's name (mkstemp with a `.md`
    /// suffix, TextEdit's "(A Document Being Saved By …)" folder) moves the
    /// temp onto the note. The note must never read as removed, and the report
    /// must name it as the destination, so the shell re-reads it.
    #[test]
    fn an_atomic_save_through_a_note_named_temp_reports_the_note_rewritten() {
        let root = temp_vault("md-temp");
        let note = root.join("note.md");
        std::fs::write(&note, "v0").unwrap();
        std::fs::create_dir_all(root.join("(A Document Being Saved By Editor)")).unwrap();
        let watch = NativeWatch::start(&root);

        let temp = root.join("tmpk3j2v9.md");
        std::fs::write(&temp, "v1").unwrap();
        std::fs::rename(&temp, &note).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let temp = root.join("(A Document Being Saved By Editor)/note.md");
        std::fs::write(&temp, "v2").unwrap();
        std::fs::rename(&temp, &note).unwrap();
        let (seen, raw) = watch.settle();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(
            !seen.iter().any(|entry| entry == "unlink note.md"),
            "the rewritten note read as removed; sink saw {seen:?}, backend sent {raw:?}"
        );
        for temp in ["tmpk3j2v9.md", "(A Document Being Saved By Editor)/note.md"] {
            let onto_note = format!("rename {temp} -> note.md");
            assert!(
                seen.contains(&onto_note)
                    || seen.iter().any(|entry| entry == "change note.md"),
                "the save through {temp} never named note.md; sink saw {seen:?}, backend sent {raw:?}"
            );
        }
    }

    /// A note moved out of the vault (the Trash is outside it) has no new half.
    /// Waiting for one must not let it claim the destination of an unrelated
    /// atomic save that lands next: that reported the removed note renamed onto
    /// the saved one, and an editor open on it followed there.
    #[test]
    fn a_note_moved_out_of_the_vault_is_removed_and_never_paired_with_an_unrelated_save() {
        let root = temp_vault("out");
        let outside = temp_vault("out-trash");
        for delay_ms in [0u64, 30, 150] {
            let gone = format!("Gone {delay_ms}.md");
            let saved = format!("other {delay_ms}.md");
            std::fs::write(root.join(&gone), "gone").unwrap();
            std::fs::write(root.join(&saved), "v0").unwrap();
            let watch = NativeWatch::start(&root);

            std::fs::rename(root.join(&gone), outside.join(&gone)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let temp = root.join(format!(".{saved}.tmp123"));
            std::fs::write(&temp, "v1").unwrap();
            std::fs::rename(&temp, root.join(&saved)).unwrap();
            let (seen, raw) = watch.settle();

            let unlink = format!("unlink {gone}");
            assert!(
                !seen.iter().any(|entry| entry.starts_with("rename ")),
                "delay {delay_ms} ms: an unrelated save was paired as a rename; sink saw {seen:?}, backend sent {raw:?}"
            );
            assert!(
                seen.contains(&unlink),
                "delay {delay_ms} ms: the moved-out note was never reported removed; sink saw {seen:?}, backend sent {raw:?}"
            );
            assert!(
                seen.iter()
                    .any(|entry| *entry == format!("change {saved}") || *entry == format!("add {saved}")),
                "delay {delay_ms} ms: the save was never reported; sink saw {seen:?}, backend sent {raw:?}"
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// A note moved out of the vault is reported removed once the pair window
    /// closes, on every backend, even when no later event arrives to flush it.
    #[test]
    fn a_note_moved_out_of_the_vault_is_reported_removed_after_the_pair_window() {
        let root = temp_vault("moved-out");
        let outside = temp_vault("moved-out-trash");
        std::fs::write(root.join("Gone.md"), "gone").unwrap();
        let watch = NativeWatch::start(&root);

        let moved_at = std::time::Instant::now();
        std::fs::rename(root.join("Gone.md"), outside.join("Gone.md")).unwrap();
        let removed = watch
            .recorder
            .wait_for("unlink Gone.md", std::time::Duration::from_secs(3));
        let elapsed = moved_at.elapsed();
        let (seen, raw) = watch.settle();
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();

        assert!(
            removed,
            "never reported removed; sink saw {seen:?}, backend sent {raw:?}"
        );
        assert!(
            elapsed >= std::time::Duration::from_millis(RENAME_PAIR_TIMEOUT_MS as u64),
            "reported removed after {elapsed:?}, before its pair window closed"
        );
    }
}
