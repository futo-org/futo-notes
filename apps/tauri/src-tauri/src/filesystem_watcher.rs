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

/// Old names of cookieless renames, oldest first, waiting for their new half.
#[derive(Default)]
struct UnpairedRenames {
    old_names: std::collections::VecDeque<PendingRename>,
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
    unpaired_renames: Arc<Mutex<UnpairedRenames>>,
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
            unpaired_renames: Arc::default(),
            sink,
            mode,
        }
    }

    fn process(&self, event: Event) {
        let Some(kind) = classify(&event, self.mode) else {
            return;
        };
        self.flush_stale_renames();
        match kind {
            ChangeKind::RenameFrom => self.rename_from(event),
            ChangeKind::RenameTo => self.rename_to(event),
            ChangeKind::RenameEither => self.rename_either(event),
            // FSEvents coalesces flags per path, so a rename's old name can also
            // carry its earlier create/write after the file is gone. A path that
            // no longer exists was not added or edited: the rename or removal
            // half reports it. Reporting it as an edit made the shell flush the
            // open note's pending save to that id and recreate it there.
            ChangeKind::Add => self.emit_existing_paths("add", event.paths),
            ChangeKind::Change => self.emit_existing_paths("change", event.paths),
            ChangeKind::Unlink => self.emit_paths("unlink", event.paths),
        }
    }

    fn flush_stale_renames(&self) {
        let Ok(mut pending) = self.pending_renames.lock() else {
            return;
        };
        let now = futo_notes_core::files::now_ms();
        let stale = pending
            .iter()
            .filter_map(|(cookie, rename)| {
                (now - rename.inserted_at > RENAME_PAIR_TIMEOUT_MS).then_some(*cookie)
            })
            .collect::<Vec<_>>();
        for cookie in stale {
            if let Some(rename) = pending.remove(&cookie) {
                self.emit_path("unlink", &rename.from_path);
            }
        }
        drop(pending);

        let stale = {
            let Ok(mut unpaired) = self.unpaired_renames.lock() else {
                return;
            };
            let fresh = unpaired
                .old_names
                .iter()
                .position(|rename| now - rename.inserted_at <= RENAME_PAIR_TIMEOUT_MS)
                .unwrap_or(unpaired.old_names.len());
            unpaired.old_names.drain(..fresh).collect::<Vec<_>>()
        };
        for rename in stale {
            self.emit_path("unlink", &rename.from_path);
        }
    }

    /// A rename half with no cookie. Its old name no longer exists and its new
    /// one does, and the backend delivers the old name first (FSEvents orders
    /// by event id), so the halves pair in arrival order.
    fn rename_either(&self, event: Event) {
        for path in event.paths {
            if path_exists(&path) {
                self.pair_new_name(path, "change");
            } else {
                self.queue_old_name(path);
            }
        }
    }

    /// Hold a cookieless old name for its new half. If the pair window closes
    /// first (the file left the vault, e.g. for the Trash), it is reported as
    /// removed — by a timer, since no later event may come to flush it.
    fn queue_old_name(&self, path: PathBuf) {
        if relative_note_path_any(&self.bases, &path).is_none() {
            return;
        }
        let Ok(mut unpaired) = self.unpaired_renames.lock() else {
            return;
        };
        unpaired.old_names.push_back(PendingRename {
            from_path: path,
            inserted_at: futo_notes_core::files::now_ms(),
        });
        if unpaired.flusher_running {
            return;
        }
        let processor = self.clone();
        let started = crate::background_tasks::spawn("watcher-rename-pairing", move || loop {
            std::thread::sleep(std::time::Duration::from_millis(
                RENAME_PAIR_TIMEOUT_MS as u64 + 50,
            ));
            processor.flush_stale_renames();
            let Ok(mut unpaired) = processor.unpaired_renames.lock() else {
                return;
            };
            if unpaired.old_names.is_empty() {
                unpaired.flusher_running = false;
                return;
            }
        });
        unpaired.flusher_running = started.is_ok();
    }

    /// Pair a cookieless new name with the oldest waiting old name. Without
    /// one it keeps its unpaired meaning (`unpaired_kind`).
    fn pair_new_name(&self, path: PathBuf, unpaired_kind: &str) {
        let old_name = if relative_note_path_any(&self.bases, &path).is_some() {
            self.unpaired_renames
                .lock()
                .ok()
                .and_then(|mut unpaired| unpaired.old_names.pop_front())
        } else {
            None
        };
        match old_name {
            Some(old_name) => self.emit_rename_pair(&old_name.from_path, &path),
            None => self.emit_path(unpaired_kind, &path),
        }
    }

    fn rename_from(&self, event: Event) {
        let mut paths = event.paths.into_iter();
        let first = paths.next();
        if let (Some(cookie), Some(path)) = (event.attrs.tracker(), first.clone()) {
            if let Ok(mut pending) = self.pending_renames.lock() {
                pending.insert(
                    cookie as u128,
                    PendingRename {
                        from_path: path,
                        inserted_at: futo_notes_core::files::now_ms(),
                    },
                );
            }
            return;
        }
        // No cookie (Windows): wait for the new half instead of reporting a
        // removal and an add.
        for path in first.into_iter().chain(paths) {
            self.queue_old_name(path);
        }
    }

    fn rename_to(&self, event: Event) {
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
                self.emit_rename_pair(&from, &to);
                return;
            }
        } else if let Some(to) = first {
            self.pair_new_name(to, "add");
            self.emit_existing_paths("add", paths);
            return;
        }
        self.emit_existing_paths("add", first.into_iter().chain(paths));
    }

    fn emit_rename_pair(&self, from: &Path, to: &Path) {
        let from = relative_note_path_any(&self.bases, from);
        let to = relative_note_path_any(&self.bases, to);
        match (from, to) {
            (Some(from), Some(to)) => self.sink.rename(&from, &to),
            (Some(from), None) => self.sink.change("unlink", &from),
            (None, Some(to)) => self.sink.change("add", &to),
            (None, None) => {}
        }
    }

    fn emit_path(&self, kind: &str, path: &Path) {
        if let Some(relative) = relative_note_path_any(&self.bases, path) {
            self.sink.change(kind, &relative);
        }
    }

    fn emit_existing_paths(&self, kind: &str, paths: impl IntoIterator<Item = PathBuf>) {
        self.emit_paths(kind, paths.into_iter().filter(|path| path_exists(path)));
    }

    fn emit_paths(&self, kind: &str, paths: impl IntoIterator<Item = PathBuf>) {
        for path in paths {
            self.emit_path(kind, &path);
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

    /// The platform's own backend — FSEvents on macOS, inotify on Linux,
    /// ReadDirectoryChangesW on Windows — reports a rename inside the vault as
    /// one rename, never as an edit or a removal of either name (M26: this runs
    /// on each desktop platform's real backend, not only on a synthetic shape).
    #[test]
    fn the_native_backend_reports_a_rename_as_one_rename() {
        let root = temp_vault("native");
        std::fs::write(root.join("Draft.md"), "draft").unwrap();
        // Let the creation age out of the backend's coalescing window.
        std::thread::sleep(std::time::Duration::from_millis(1_000));

        let (processor, recorder) = recording_processor(&root);
        let raw = Arc::new(Mutex::new(Vec::<String>::new()));
        let raw_log = raw.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    raw_log.lock().unwrap().push(format!(
                        "{:?} {:?} {:?}",
                        event.kind,
                        event.paths,
                        event.attrs.tracker()
                    ));
                    processor.process(event);
                }
            },
            Config::default(),
        )
        .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        recorder.take();
        raw.lock().unwrap().clear();

        std::fs::rename(root.join("Draft.md"), root.join("Draft renamed.md")).unwrap();
        let renamed = recorder.wait_for(
            "rename Draft.md -> Draft renamed.md",
            std::time::Duration::from_secs(5),
        );
        // Anything the pair window would still turn into a removal lands here.
        std::thread::sleep(std::time::Duration::from_millis(
            RENAME_PAIR_TIMEOUT_MS as u64 + 500,
        ));
        drop(watcher);
        let seen = recorder.take();
        let raw = raw.lock().unwrap().clone();
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
}
