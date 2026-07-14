//! Vault filesystem watcher and self-write event suppression.
//!
//! Commands mutate the vault optimistically from the frontend. Before a Rust
//! mutation touches disk it registers the affected relative paths here; the
//! corresponding `notify` echo is consumed exactly once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{
    event::{ModifyKind, RenameMode},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::application_state::AppState;
use crate::background_tasks::blocking;

const SUPPRESSION_WINDOW_MS: i64 = 5_000;
const RENAME_PAIR_TIMEOUT_MS: i64 = 500;

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

    /// Remove a suppression entry registered by `register` when the planned
    /// write did not happen (a no-replace create hit EEXIST), so it can't eat
    /// the peer's own event or a later real edit (C2).
    pub(crate) fn unregister(&self, relative_path: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(relative_path);
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
    active: Arc<Mutex<Option<RecommendedWatcher>>>,
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

#[derive(Debug, PartialEq, Eq)]
enum ChangeKind {
    Add,
    Change,
    Unlink,
    RenameFrom,
    RenameTo,
}

fn classify(event: &Event) -> Option<ChangeKind> {
    match &event.kind {
        EventKind::Create(_) => Some(ChangeKind::Add),
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(ChangeKind::RenameFrom),
        EventKind::Modify(ModifyKind::Name(RenameMode::To | RenameMode::Both)) => {
            Some(ChangeKind::RenameTo)
        }
        EventKind::Modify(_) => Some(ChangeKind::Change),
        EventKind::Remove(_) => Some(ChangeKind::Unlink),
        _ => None,
    }
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

#[derive(Clone)]
struct EventSink {
    app: AppHandle,
    suppression: WatcherSuppression,
}

impl EventSink {
    fn change(&self, kind: &str, relative_path: &str) {
        if relative_path.is_empty() {
            return;
        }
        let lower = relative_path.to_lowercase();
        if !lower.ends_with(".md") && !lower.ends_with(".txt") {
            return;
        }
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

struct EventProcessor {
    bases: Vec<PathBuf>,
    pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
    sink: EventSink,
}

impl EventProcessor {
    fn process(&self, event: Event) {
        let Some(kind) = classify(&event) else {
            return;
        };
        self.flush_stale_renames();
        match kind {
            ChangeKind::RenameFrom => self.rename_from(event),
            ChangeKind::RenameTo => self.rename_to(event),
            ChangeKind::Add => self.emit_paths("add", event.paths),
            ChangeKind::Change => self.emit_paths("change", event.paths),
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
        if let Some(path) = first {
            self.emit_path("unlink", &path);
        }
        self.emit_paths("unlink", paths);
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
        }
        if let Some(path) = first {
            self.emit_path("add", &path);
        }
        self.emit_paths("add", paths);
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
        let processor = EventProcessor {
            bases: watch_bases(&root),
            pending_renames,
            sink: EventSink { app, suppression },
        };
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, _>| {
                if let Ok(event) = result {
                    processor.process(event);
                }
            },
            Config::default(),
        )
        .map_err(|error| error.to_string())?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        *active = Some(watcher);
        Ok(())
    })
    .await
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
            classify(&Event::new(EventKind::Create(
                notify::event::CreateKind::File
            ))),
            Some(ChangeKind::Add)
        );
        assert_eq!(
            classify(&Event::new(EventKind::Modify(ModifyKind::Metadata(
                notify::event::MetadataKind::Permissions
            )))),
            None
        );
        assert_eq!(
            classify(&Event::new(EventKind::Remove(
                notify::event::RemoveKind::File
            ))),
            Some(ChangeKind::Unlink)
        );
    }
}
