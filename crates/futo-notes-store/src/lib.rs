//! One durable owner for the local Markdown vault and its derived search index.

mod paths;
mod vault;
mod vault_migration;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futo_notes_core::conflict_names::{conflict_filename, current_conflict_date};
use futo_notes_core::files::{
    collides_but_differs, create_new_atomic, move_no_replace, rename_through_temp,
    safe_appdata_path, set_file_mtime_ms, write_atomic_text,
};
use futo_notes_model::{make_id, rewrite_wikilinks, sanitize_folder_path, split_id};
use futo_notes_search::{SearchConfig, SearchEngine, StatusObserver, DEFAULT_TOPK};
use serde::{Deserialize, Serialize};

pub use futo_notes_model::{WELCOME_NOTE, WELCOME_NOTE_ID};
pub use futo_notes_search::{SearchHit, SearchStatus};
pub use vault_migration::{
    VaultMigrationFinalization, VaultMigrationOutcome, VaultMigrationStatus,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub modified_ms: i64,
    pub preview: String,
    pub rich_preview: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub notes: Vec<NoteMetadata>,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRename {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertedNote {
    pub note: NoteMetadata,
    /// Post-mutation index after affected rows are removed.
    pub position: u32,
}

/// Complete committed projection for shell caches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub upserted: Vec<UpsertedNote>,
    pub removed: Vec<String>,
    pub renamed: Vec<NoteRename>,
    pub folders: Vec<String>,
    /// Collision-resolved primary id, if the workflow has one.
    pub final_id: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResult {
    pub snapshot: Snapshot,
    pub seeded: u32,
    pub migrated: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub name: String,
    pub mtime_ms: i64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushOutcome {
    Wrote,
    SkippedMissing,
    SkippedChanged,
}

/// Outcome of [`LocalNoteStore::create_if_absent`] — an atomic create-if-absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateOutcome {
    /// No file existed at the id; `content` was created there.
    Created,
    /// A file already exists at the id — nothing written (a concurrent writer,
    /// e.g. a live-sync pull, got there first).
    Existed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionalWriteResult {
    pub outcome: FlushOutcome,
    pub mutation: Option<MutationResult>,
}

/// The single outcome of one draft flush (CONTEXT.md: flush disposition).
/// Shells render dispositions; they never decide them (ADR-0001).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlushDisposition {
    /// The note still held `base`; the draft is committed at its id.
    Wrote,
    /// Disk already equals the draft — nothing written, no mtime bump.
    /// Explicit so shells never read disk to compare.
    Converged,
    /// A peer deleted the note; the edit wins — recreated at the ORIGINAL id.
    Recreated,
    /// A peer changed the note (or its id reappeared inside the flush); the
    /// draft is parked as a conflict copy and the diverged note is untouched.
    #[serde(rename_all = "camelCase")]
    ParkedConflict { parked_id: String },
}

/// What [`LocalNoteStore::flush_draft`] committed: one disposition plus the
/// mutation to project (`None` when nothing changed on disk — converged, or
/// a park that found its copy already minted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushDraftResult {
    pub disposition: FlushDisposition,
    pub mutation: Option<MutationResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileChange {
    Changed(String),
    Removed(String),
    Renamed { from: String, to: String },
}

/// Desktop uses this hook to register one-shot watcher suppression before the
/// first filesystem syscall. Native shells use the no-op implementation.
pub trait BeforeWrite: Send + Sync {
    fn before_write(&self, changes: &[FileChange]);
}

#[derive(Default)]
pub struct NoopBeforeWrite;

impl BeforeWrite for NoopBeforeWrite {
    fn before_write(&self, _changes: &[FileChange]) {}
}

/// After a failed search-engine start (a bad/locked index dir, momentary disk
/// pressure), the store re-attempts the start lazily on the next
/// search/status/rescan call — but at most once per this cooldown, so a
/// persistent failure does not reopen the Tantivy index on every keystroke.
/// This is the iOS `SearchService` F13 self-heal (PKT-10) pushed down into the
/// single Rust owner, so iOS, Android, and desktop share one implementation
/// (and it closes the banked Android search-retry-cooldown alignment follow-up).
const SEARCH_ENGINE_RETRY_COOLDOWN: Duration = Duration::from_secs(15);

/// Poll cadence inside [`LocalNoteStore::wait_until_search_ready`] — matches
/// the 25ms the shells used before the wait moved down here.
const SEARCH_READY_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The owned search engine plus what's needed to re-attempt a failed start.
#[derive(Default)]
struct SearchState {
    engine: Option<SearchEngine>,
    /// Index dir + status observer retained at `start_search` so a failed start
    /// can be retried with the same configuration. `None` until first start.
    pending: Option<(PathBuf, StatusObserver)>,
    /// When the last start attempt failed; gates the retry cooldown.
    last_start_failure: Option<Instant>,
}

#[cfg(test)]
type InstallWindowHook = Box<dyn Fn(&str) + Send + Sync>;

/// One instance owns one vault. Every mutation is serialized through `gate`,
/// so conditional writes and multi-file rename/relink operations have a
/// single-process decision boundary shared by all shells.
pub struct LocalNoteStore {
    root: PathBuf,
    before_write: Arc<dyn BeforeWrite>,
    gate: Mutex<()>,
    search: Mutex<SearchState>,
    retry_cooldown: Duration,
    /// Fault injection fired between id allocation and no-replace installation
    /// to simulate a concurrent writer landing at the chosen id.
    #[cfg(test)]
    install_window_hook: Mutex<Option<InstallWindowHook>>,
}

impl LocalNoteStore {
    pub fn new(root: PathBuf) -> Self {
        Self::with_before_write(root, Arc::new(NoopBeforeWrite))
    }

    pub fn with_before_write(root: PathBuf, before_write: Arc<dyn BeforeWrite>) -> Self {
        Self {
            root,
            before_write,
            gate: Mutex::new(()),
            search: Mutex::new(SearchState::default()),
            retry_cooldown: SEARCH_ENGINE_RETRY_COOLDOWN,
            #[cfg(test)]
            install_window_hook: Mutex::new(None),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Starts reconciliation in the search engine's background runtime. The
    /// caller is expected to invoke this off the UI thread; note-list startup
    /// never waits for keyword readiness.
    pub fn start_search(
        &self,
        index_dir: PathBuf,
        on_status: StatusObserver,
    ) -> Result<(), String> {
        let mut search = self
            .search
            .lock()
            .map_err(|_| "search lock poisoned".to_owned())?;
        if search.engine.is_some() {
            return Ok(());
        }
        search.pending = Some((index_dir, on_status));
        self.try_start_engine(&mut search)
    }

    pub fn search(&self, query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
        let mut search = self
            .search
            .lock()
            .map_err(|_| "search lock poisoned".to_owned())?;
        self.ensure_engine(&mut search);
        match search.engine.as_ref() {
            Some(engine) => engine.query(query, limit.unwrap_or(DEFAULT_TOPK)),
            None => Ok(Vec::new()),
        }
    }

    fn search_status(&self) -> SearchStatus {
        let Ok(mut search) = self.search.lock() else {
            return SearchStatus::default();
        };
        self.ensure_engine(&mut search);
        search
            .engine
            .as_ref()
            .map(SearchEngine::status)
            .unwrap_or_default()
    }

    /// Blocking, bounded wait for engine-owned search readiness. Callers keep
    /// it off the UI thread; a timeout safely degrades to empty search results
    /// while the index continues its self-healing retries.
    pub fn wait_until_search_ready(&self, timeout_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if self.search_status().keyword.ready {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            std::thread::sleep(SEARCH_READY_POLL_INTERVAL.min(deadline - now));
        }
    }

    pub fn rebuild_search(&self) {
        if let Ok(mut search) = self.search.lock() {
            self.ensure_engine(&mut search);
            if let Some(engine) = search.engine.as_ref() {
                engine.rescan();
            }
        }
    }

    /// Start the engine from the retained config, recording success/failure.
    /// The caller holds the search lock.
    fn try_start_engine(&self, search: &mut SearchState) -> Result<(), String> {
        let Some((index_dir, on_status)) = search.pending.clone() else {
            return Ok(());
        };
        match SearchEngine::start(
            SearchConfig {
                notes_root: self.root.clone(),
                index_dir,
            },
            on_status,
        ) {
            Ok(engine) => {
                search.engine = Some(engine);
                search.last_start_failure = None;
                Ok(())
            }
            Err(error) => {
                search.last_start_failure = Some(Instant::now());
                Err(error)
            }
        }
    }

    /// Lazily (re-)attempt a search-engine start that has not yet succeeded,
    /// gated by [`SEARCH_ENGINE_RETRY_COOLDOWN`] so a persistent failure is not
    /// retried on every call. No-op once the engine is running or when nothing
    /// has been started yet. The caller holds the search lock.
    fn ensure_engine(&self, search: &mut SearchState) {
        if search.engine.is_some() || search.pending.is_none() {
            return;
        }
        let cooling_down = search
            .last_start_failure
            .is_some_and(|at| at.elapsed() < self.retry_cooldown);
        if cooling_down {
            return;
        }
        // A failed retry re-arms the cooldown inside `try_start_engine`.
        let _ = self.try_start_engine(search);
    }

    pub fn observe_external_change(&self, change: FileChange) {
        self.notify(&change);
    }

    pub fn bootstrap(&self) -> Result<BootstrapResult, String> {
        let _gate = self.lock_gate()?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        // Recover notes stranded by a crash inside a collision-fallback install
        // BEFORE migrate/scan/seed, so recovered notes are in this run's
        // snapshot and an empty-vault seed can't fire while a real note is only
        // stranded (A2). Divergent backups the sweep cannot canonically restore
        // are parked under a visible recovered name here rather than left
        // eligible for a resurrecting restore (C1).
        let mut warnings = Vec::new();
        for recovered in futo_notes_core::files::recover_parked_backups(&self.root) {
            if let Err(error) = self.park_recovered_backup(&recovered) {
                warnings.push(format!("recovered note {}: {error}", recovered.leaf));
            }
        }
        let (migrated, migrate_warnings) = self.migrate_text_files();
        warnings.extend(migrate_warnings);
        let seeded = if vault::note_paths(&self.root).is_empty() {
            match self.write_raw(WELCOME_NOTE_ID, WELCOME_NOTE, None) {
                Ok(_) => 1,
                Err(error) => {
                    warnings.push(format!("welcome note: {error}"));
                    0
                }
            }
        } else {
            0
        };
        Ok(BootstrapResult {
            snapshot: vault::snapshot(&self.root),
            seeded,
            migrated,
            warnings,
        })
    }

    /// Bootstrap the vault, then start the owned search index in the background
    /// as a BEST-EFFORT step: a search-start failure is recorded as a warning,
    /// never fatal, so the note list always renders even when the index can't
    /// open (it self-heals later via the retry cooldown — see `ensure_engine`).
    /// The single rule every adapter's bootstrap shares, so no shell can make
    /// search startup gate the vault (A3).
    pub fn bootstrap_with_search(
        &self,
        index_dir: PathBuf,
        on_status: StatusObserver,
    ) -> Result<BootstrapResult, String> {
        let mut result = self.bootstrap()?;
        if let Err(error) = self.start_search(index_dir, on_status) {
            result.warnings.push(format!("search startup: {error}"));
        }
        Ok(result)
    }

    pub fn snapshot(&self) -> Snapshot {
        vault::snapshot(&self.root)
    }

    pub fn inventory(&self) -> Vec<VaultFile> {
        vault::inventory(&self.root)
    }

    pub fn read(&self, id: &str) -> String {
        paths::note_path(&self.root, id)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .unwrap_or_default()
    }

    pub fn exists(&self, id: &str) -> bool {
        paths::note_path(&self.root, id)
            .map(|path| path.is_file())
            .unwrap_or(false)
    }

    pub fn create(
        &self,
        folder: &str,
        title: &str,
        content: &str,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let metadata = self.install_new(&make_id(folder, title), content, None)?;
        Ok(self.upsert_mutation(metadata))
    }

    pub fn write(
        &self,
        id: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let metadata = self.write_raw(id, content, modified_ms)?;
        Ok(self.upsert_mutation(metadata))
    }

    /// One shell call for editor save: the current body is committed at the
    /// old ID first, then any rename and every resolvable backlink rewrite are
    /// performed under the same vault lock.
    pub fn save(
        &self,
        original_id: Option<&str>,
        wanted_id: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        match original_id {
            None => {
                let (folder, title) = split_id(wanted_id);
                let metadata = self.install_new(&make_id(&folder, &title), content, modified_ms)?;
                Ok(self.upsert_mutation(metadata))
            }
            Some(original) if original == wanted_id => {
                let metadata = self.write_raw(original, content, modified_ms)?;
                Ok(self.upsert_mutation(metadata))
            }
            Some(original) => {
                self.write_raw(original, content, modified_ms)?;
                self.rename_raw(original, wanted_id)
            }
        }
    }

    pub fn write_if_unchanged(
        &self,
        id: &str,
        expected: &str,
        content: &str,
    ) -> Result<ConditionalWriteResult, String> {
        let _gate = self.lock_gate()?;
        let path = paths::note_path(&self.root, id)?;
        match fs::read_to_string(&path) {
            Ok(current) if current == expected => {
                let metadata = self.write_raw(id, content, None)?;
                Ok(ConditionalWriteResult {
                    outcome: FlushOutcome::Wrote,
                    mutation: Some(self.upsert_mutation(metadata)),
                })
            }
            Ok(_) => Ok(ConditionalWriteResult {
                outcome: FlushOutcome::SkippedChanged,
                mutation: None,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(ConditionalWriteResult {
                    outcome: FlushOutcome::SkippedMissing,
                    mutation: None,
                })
            }
            Err(error) => Err(io_error(error)),
        }
    }

    /// Atomically (re-)create the note at `id` with `content` ONLY IF no file
    /// exists there yet — a no-replace install via [`create_new_atomic`], so a
    /// concurrent scan/sync never observes an empty or partial file. The
    /// editor's leave/background flush uses this to
    /// honor the peer-delete dirty-keep edit-wins semantic: recreate a note the
    /// conditional flush just reported [`FlushOutcome::SkippedMissing`] for,
    /// WITHOUT the unconditional-write clobber risk — a live-sync pull writing
    /// the same id OUTSIDE this store's serialization cannot have its content
    /// overwritten. Returns [`CreateOutcome::Existed`] if the id reappeared in
    /// the window (the caller parks a conflict copy instead). On a
    /// case-insensitive filesystem (APFS/iOS) a case-variant already on disk
    /// counts as existing — the safe outcome, we never clobber it.
    pub fn create_if_absent(&self, id: &str, content: &str) -> Result<CreateOutcome, String> {
        let _gate = self.lock_gate()?;
        let path = paths::note_path(&self.root, id)?;
        let change = FileChange::Changed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        if create_new_atomic(&path, content.as_bytes())? {
            self.notify(&change);
            Ok(CreateOutcome::Created)
        } else {
            Ok(CreateOutcome::Existed)
        }
    }

    /// THE draft-saving verb (persist-or-park, ADR-0001 / issue #37): persist
    /// `content` for the note at `id`, resolving every surprise itself, and
    /// return one [`FlushDisposition`] plus the mutation to project. `base` is
    /// the content the editor last loaded or saved — what detects that the
    /// note changed underneath the draft.
    ///
    /// The whole composition holds the mutation gate once, so no check-then-act
    /// window spans app-facing calls (the P1a TOCTOU that lived between the raw
    /// `write_if_unchanged`/`create_if_absent`/park FFI calls). External/sync
    /// writers are NOT serialized by the gate, so every install remains
    /// no-replace and re-validates instead of clobbering.
    pub fn flush_draft(
        &self,
        id: &str,
        base: &str,
        content: &str,
    ) -> Result<FlushDraftResult, String> {
        let _gate = self.lock_gate()?;
        let path = paths::note_path(&self.root, id)?;
        match fs::read_to_string(&path) {
            // Converged is checked BEFORE the base comparison so a draft the
            // disk already holds never rewrites identical bytes (an mtime bump
            // would re-rank the note on every device).
            Ok(current) if current == content => Ok(FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            }),
            Ok(current) if current == base => {
                let metadata = self.write_raw(id, content, None)?;
                Ok(FlushDraftResult {
                    disposition: FlushDisposition::Wrote,
                    mutation: Some(self.upsert_mutation(metadata)),
                })
            }
            // The note changed under the editor (a live pull adopted a peer
            // edit, or an in-flight autosave advanced disk past `base`). Never
            // drop the draft: park it as a conflict copy — the diverged note on
            // disk is left intact and the edit survives as a new note.
            Ok(_) => self.park_conflict_draft(id, content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.recreate_missing_draft(id, content, &path)
            }
            Err(error) => Err(io_error(error)),
        }
    }

    /// The flush's peer-delete arm: a dirty draft is edit-wins — recreate at
    /// the ORIGINAL id (the same home the editor's resume autosave rewrites,
    /// so the survive and jetsam paths converge with no duplicate copy). The
    /// install is atomic no-replace: a live-sync pull that recreated the id
    /// outside the store's serialization is never clobbered — if the id
    /// reappeared, park the draft unless it converged.
    fn recreate_missing_draft(
        &self,
        id: &str,
        content: &str,
        path: &Path,
    ) -> Result<FlushDraftResult, String> {
        // Never recreate at an id that cross-platform-collides (case-insensitive
        // / NFC) with a DIFFERENT surviving note. `create_new_atomic` only fails
        // on an EXACT-path collision, so on a case-sensitive filesystem
        // recreating a peer-deleted "Note" beside a live "note" would install a
        // shadow `write_raw` refuses for ordinary writes. Park the edit instead —
        // the draft still survives, at a non-shadowing conflict-copy id.
        if self.colliding_note(id).is_some() {
            return self.park_conflict_draft(id, content);
        }
        let change = FileChange::Changed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        #[cfg(test)]
        if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
            hook(id);
        }
        if create_new_atomic(path, content.as_bytes())? {
            let metadata = vault::metadata(&self.root, id)
                .ok_or_else(|| "note metadata unavailable after recreate".to_owned())?;
            self.notify(&change);
            return Ok(FlushDraftResult {
                disposition: FlushDisposition::Recreated,
                mutation: Some(self.upsert_mutation(metadata)),
            });
        }
        match fs::read_to_string(path) {
            Ok(current) if current == content => Ok(FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            }),
            _ => self.park_conflict_draft(id, content),
        }
    }

    /// Park a draft that conflicts with a genuinely different on-disk version
    /// as a "<title> (conflict YYYY-MM-DD)" copy, named by the engine's one
    /// conflict-naming rule (`futo_notes_core::conflict_names` — the rule sync
    /// already uses). Idempotent: if a copy this park could have minted (the
    /// dated stem or one of its counter variants) already holds byte-identical
    /// content, the existing copy is reported and nothing new is created — a
    /// crash-window double-park mints ONE copy. Caller holds the mutation gate.
    fn park_conflict_draft(&self, id: &str, content: &str) -> Result<FlushDraftResult, String> {
        let (folder, title) = split_id(id);
        let date = current_conflict_date();
        let sibling_titles: Vec<String> = vault::note_paths(&self.root)
            .into_iter()
            .filter_map(|(sibling_id, _)| {
                let (sibling_folder, sibling_title) = split_id(&sibling_id);
                (sibling_folder == folder).then_some(sibling_title)
            })
            .collect();
        let stem = note_title(&conflict_filename(
            &note_filename(&title),
            &date,
            &HashSet::new(),
        ));
        for sibling_title in &sibling_titles {
            if !is_dated_conflict_variant(&stem, sibling_title) {
                continue;
            }
            let parked_id = join_id(&folder, sibling_title);
            if self.read(&parked_id) == content {
                return Ok(FlushDraftResult {
                    disposition: FlushDisposition::ParkedConflict { parked_id },
                    mutation: None,
                });
            }
        }
        // Mint the copy no-replace. The naming rule avoids every sibling seen
        // now; a writer outside this store's serialization landing on the
        // chosen name in the window fails the install (EEXIST), and the retry
        // re-runs the rule with that name occupied — never a clobber. Like
        // every brand-new create (see `install_new`, D2), the park registers
        // NO watcher suppression: the own-create echo reconciles idempotently
        // and a peer's colliding event must not be eaten.
        let mut existing: HashSet<String> = sibling_titles
            .iter()
            .map(|sibling_title| note_filename(sibling_title))
            .collect();
        for _ in 0..1000 {
            let filename = conflict_filename(&note_filename(&title), &date, &existing);
            let parked_id = join_id(&folder, &note_title(&filename));
            // Skip a candidate that cross-platform-collides (case-insensitive /
            // NFC) with a DIFFERENT live note: `create_new_atomic` can't see
            // that on a case-sensitive filesystem, so installing here would
            // shadow it. Occupy the name so the naming rule advances to the next
            // dated counter, then retry.
            if self.colliding_note(&parked_id).is_some() {
                existing.insert(filename);
                continue;
            }
            let path = paths::note_path(&self.root, &parked_id)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(io_error)?;
            }
            #[cfg(test)]
            if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
                hook(&parked_id);
            }
            if create_new_atomic(&path, content.as_bytes())? {
                let metadata = vault::metadata(&self.root, &parked_id)
                    .ok_or_else(|| "note metadata unavailable after park".to_owned())?;
                self.notify(&FileChange::Changed(note_filename(&parked_id)));
                return Ok(FlushDraftResult {
                    disposition: FlushDisposition::ParkedConflict {
                        parked_id: parked_id.clone(),
                    },
                    mutation: Some(self.upsert_mutation(metadata)),
                });
            }
            existing.insert(filename);
        }
        Err("could not allocate a conflict-copy id after repeated collisions".to_owned())
    }

    pub fn rename(&self, old_id: &str, wanted_id: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        self.rename_raw(old_id, wanted_id)
    }

    pub fn move_note(&self, id: &str, folder: &str) -> Result<MutationResult, String> {
        let (_, title) = split_id(id);
        let folder = sanitize_folder_path(folder);
        let wanted = if folder.is_empty() {
            title
        } else {
            format!("{folder}/{title}")
        };
        self.rename(id, &wanted)
    }

    /// Creates a new folder and moves one note into it as one serialized
    /// workflow. If the move fails, the newly-created empty folder is removed.
    pub fn move_note_to_new_folder(
        &self,
        id: &str,
        folder: &str,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let folder = sanitize_folder_path(folder);
        if folder.is_empty() {
            return Err("new folder path is empty".into());
        }
        let folder_path = paths::folder_path(&self.root, &folder)?;
        fs::create_dir(&folder_path).map_err(io_error)?;
        let (_, title) = split_id(id);
        let wanted = format!("{folder}/{title}");
        match self.rename_raw(id, &wanted) {
            Ok(mutation) => Ok(mutation),
            Err(error) => {
                let _ = fs::remove_dir(&folder_path);
                Err(error)
            }
        }
    }

    pub fn delete(&self, id: &str) -> Result<MutationResult, String> {
        self.delete_with(id, |path| match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        })
    }

    pub fn delete_with<F>(&self, id: &str, remove: F) -> Result<MutationResult, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let _gate = self.lock_gate()?;
        let path = paths::note_path(&self.root, id)?;
        if !path.exists() {
            return Ok(self.finish_mutation(Vec::new(), MutationResult::default()));
        }
        let change = FileChange::Removed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        remove(&path)?;
        prune_empty_parents(&self.root, &path);
        self.notify(&change);
        Ok(self.finish_mutation(
            Vec::new(),
            MutationResult {
                removed: vec![id.to_owned()],
                ..MutationResult::default()
            },
        ))
    }

    pub fn create_folder(&self, raw: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let clean = sanitize_folder_path(raw);
        if clean.is_empty() {
            return Ok(self.finish_mutation(Vec::new(), MutationResult::default()));
        }
        let path = paths::folder_path(&self.root, &clean)?;
        fs::create_dir_all(path).map_err(io_error)?;
        Ok(self.finish_mutation(Vec::new(), MutationResult::default()))
    }

    pub fn rename_folder(&self, from: &str, to: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        paths::folder_path(&self.root, from)?;
        paths::folder_path(&self.root, to)?;
        let from = sanitize_folder_path(from);
        let to = sanitize_folder_path(to);
        let source = paths::folder_path(&self.root, &from)?;
        let destination = paths::folder_path(&self.root, &to)?;
        if !source.is_dir() {
            return Err("source folder does not exist".to_owned());
        }
        if destination.exists() && !same_physical(&source, &destination) {
            return Err("target folder already exists".to_owned());
        }

        let prefix = format!("{from}/");
        let mappings = vault::note_paths(&self.root)
            .into_iter()
            .filter_map(|(id, _)| {
                id.strip_prefix(&prefix)
                    .map(|tail| (id.clone(), format!("{to}/{tail}")))
            })
            .collect::<Vec<_>>();
        let relinks = prepare_relinks(&self.root, &mappings);
        let mut changes = rename_changes(&mappings);
        changes.extend(
            relinks
                .keys()
                .map(|id| FileChange::Changed(note_filename(id))),
        );
        self.before_write.before_write(&changes);

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        if collides_but_differs(&from, &to) {
            rename_through_temp(&source, &destination)?;
        } else {
            // This renames a DIRECTORY, so the file no-replace primitive
            // (move_no_replace) doesn't apply, and POSIX rename onto a non-empty dir
            // fails ENOTEMPTY (no clobber). The only residual of the
            // exists()-check above is an EMPTY destination dir created in this
            // user-initiated window being replaced — no note bytes are at risk
            // (contained notes move via the mapping loop, not this dir rename).
            // A platform-specific no-replace dir rename (renameat2) isn't worth
            // it for that (M17 #8, adjudicated).
            fs::rename(&source, &destination).map_err(io_error)?;
        }
        let mut mutation = self.finish_mappings(mappings, relinks, None);
        mutation
            .warnings
            .extend(remove_empty_source_warning(&source));
        Ok(mutation)
    }

    pub fn delete_folder(&self, folder: &str) -> Result<MutationResult, String> {
        self.delete_folder_with(folder, |path| fs::remove_dir_all(path).map_err(io_error))
    }

    /// Move every note out first, with rollback on a failed move. Only after
    /// all notes are safe does the supplied platform removal policy receive
    /// the remaining tree (desktop trash or native recursive delete).
    pub fn delete_folder_with<F>(
        &self,
        folder: &str,
        remove_tree: F,
    ) -> Result<MutationResult, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let _gate = self.lock_gate()?;
        paths::folder_path(&self.root, folder)?;
        let folder = sanitize_folder_path(folder);
        let target = paths::folder_path(&self.root, &folder)?;
        if !target.exists() {
            return Ok(self.finish_mutation(Vec::new(), MutationResult::default()));
        }
        let parent = folder
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        let prefix = format!("{folder}/");
        let source_ids = vault::note_paths(&self.root)
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| id.starts_with(&prefix))
            .collect::<Vec<_>>();
        let mut occupied = vault::note_paths(&self.root)
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| !source_ids.contains(id))
            .collect::<HashSet<_>>();
        let mut mappings = Vec::with_capacity(source_ids.len());
        for old in source_ids {
            let tail = &old[prefix.len()..];
            let wanted = if parent.is_empty() {
                tail.to_owned()
            } else {
                format!("{parent}/{tail}")
            };
            let destination = paths::unique_against(&wanted, &occupied);
            occupied.insert(destination.clone());
            mappings.push((old, destination));
        }

        let relinks = prepare_relinks(&self.root, &mappings);
        let mut changes = rename_changes(&mappings);
        changes.extend(
            relinks
                .keys()
                .map(|id| FileChange::Changed(note_filename(id))),
        );
        self.before_write.before_write(&changes);
        move_files_with_rollback(&self.root, &mappings)?;
        let cleanup_warning = remove_tree(&target)
            .err()
            .map(|error| format!("notes moved, but folder cleanup failed: {error}"));
        let mut mutation = self.finish_mappings(mappings, relinks, None);
        mutation.warnings.extend(cleanup_warning);
        Ok(mutation)
    }

    /// Destructive local reset. Session/sync shutdown ordering remains a shell
    /// responsibility; once called, this removes every vault entry, including
    /// images and hidden app-data, and reconciles search from the empty tree.
    pub fn reset(&self) -> Result<(), String> {
        let _gate = self.lock_gate()?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let removals = vault::note_paths(&self.root)
            .into_iter()
            .map(|(id, _)| FileChange::Removed(note_filename(&id)))
            .collect::<Vec<_>>();
        self.before_write.before_write(&removals);
        for entry in fs::read_dir(&self.root).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            if path.is_dir() {
                fs::remove_dir_all(path).map_err(io_error)?;
            } else {
                fs::remove_file(path).map_err(io_error)?;
            }
        }
        self.rebuild_search();
        Ok(())
    }

    /// Stages a verified whole-vault copy while keeping the source intact.
    pub fn stage_vault_migration(
        &self,
        destination: &Path,
    ) -> Result<VaultMigrationOutcome, String> {
        let _gate = self.lock_gate()?;
        vault_migration::stage(&self.root, destination)
    }

    /// Deletes the source vault only after the shell durably selects the verified destination.
    pub fn finalize_vault_migration(
        &self,
        destination: &Path,
    ) -> Result<VaultMigrationFinalization, String> {
        let _gate = self.lock_gate()?;
        vault_migration::finalize(&self.root, destination)
    }

    fn rename_raw(&self, old_id: &str, wanted_id: &str) -> Result<MutationResult, String> {
        if old_id == wanted_id {
            let upserted = vault::metadata(&self.root, old_id).into_iter().collect();
            return Ok(self.finish_mutation(
                upserted,
                MutationResult {
                    final_id: Some(old_id.to_owned()),
                    ..MutationResult::default()
                },
            ));
        }
        let source = paths::note_path(&self.root, old_id)?;
        if !source.is_file() {
            return Err("source note does not exist".to_owned());
        }
        let final_id = paths::unique_note_id(&self.root, wanted_id, Some(old_id))?;
        let mappings = vec![(old_id.to_owned(), final_id.clone())];
        let relinks = prepare_relinks(&self.root, &mappings);
        let mut changes = rename_changes(&mappings);
        changes.extend(
            relinks
                .keys()
                .map(|id| FileChange::Changed(note_filename(id))),
        );
        self.before_write.before_write(&changes);
        move_files_with_rollback(&self.root, &mappings)?;
        Ok(self.finish_mappings(mappings, relinks, Some(final_id)))
    }

    fn finish_mappings(
        &self,
        mappings: Vec<(String, String)>,
        relinks: HashMap<String, String>,
        final_id: Option<String>,
    ) -> MutationResult {
        let mut warnings = Vec::new();
        let mut touched = HashSet::new();
        for (id, content) in relinks {
            match paths::note_path(&self.root, &id)
                .and_then(|path| write_atomic_text(&path, &content))
            {
                Ok(()) => {
                    touched.insert(id.clone());
                    self.notify(&FileChange::Changed(note_filename(&id)));
                }
                Err(error) => warnings.push(format!("backlink rewrite for {id}: {error}")),
            }
        }
        for (from, to) in &mappings {
            self.notify(&FileChange::Renamed {
                from: note_filename(from),
                to: note_filename(to),
            });
            touched.insert(to.clone());
        }
        let upserted = touched
            .into_iter()
            .filter_map(|id| vault::metadata(&self.root, &id))
            .collect::<Vec<_>>();
        self.finish_mutation(
            upserted,
            MutationResult {
                removed: mappings.iter().map(|(from, _)| from.clone()).collect(),
                renamed: mappings
                    .into_iter()
                    .map(|(from, to)| NoteRename { from, to })
                    .collect(),
                final_id,
                warnings,
                ..MutationResult::default()
            },
        )
    }

    /// A single-note upsert mutation: the note is its own primary, so its
    /// (collision-resolved) id is the mutation's final id.
    fn upsert_mutation(&self, metadata: NoteMetadata) -> MutationResult {
        let final_id = metadata.id.clone();
        self.finish_mutation(
            vec![metadata],
            MutationResult {
                final_id: Some(final_id),
                ..MutationResult::default()
            },
        )
    }

    /// Complete the authoritative shell projection while the mutation gate is
    /// held. Externally removed upserts fall back to the clamped list tail.
    fn finish_mutation(
        &self,
        notes: Vec<NoteMetadata>,
        mut mutation: MutationResult,
    ) -> MutationResult {
        let (order, folders) = vault::note_order_and_folders(&self.root);
        let index: HashMap<&str, u32> = order
            .iter()
            .enumerate()
            .map(|(position, id)| (id.as_str(), position as u32))
            .collect();
        mutation.upserted = notes
            .into_iter()
            .map(|note| UpsertedNote {
                position: index
                    .get(note.id.as_str())
                    .copied()
                    .unwrap_or(order.len() as u32),
                note,
            })
            .collect();
        mutation.upserted.sort_by(|left, right| {
            left.position
                .cmp(&right.position)
                .then_with(|| left.note.id.cmp(&right.note.id))
        });
        mutation.folders = folders;
        mutation
    }

    /// Install a brand-new note at a collision-free id using a NO-REPLACE
    /// atomic create. The store mutex serializes only this process's mutations,
    /// NOT an external/sync writer, so between id allocation and install a file
    /// can appear at the chosen id. `create_new_atomic` fails (EEXIST) rather
    /// than overwriting; we re-allocate a fresh suffix — now seeing that file —
    /// and retry, so a create never silently clobbers a note this store did not
    /// write. (An overwrite install here is the A1 data-loss window.)
    ///
    /// A brand-new create registers NO watcher suppression (D2, two-strikes
    /// redesign of the create path): there was no fixed suppress-vs-install
    /// ordering that both hid our own echo and never ate a peer/collision event
    /// (B3 → C2 → D2). The own-create echo is instead made harmless — the
    /// desktop watcher's create reconcile is idempotent (the id is already in
    /// the cache with identical content, so `refreshNotesFromStorage` is a
    /// no-op mutation; no toast, no editor disturbance), and the collision case
    /// is automatically correct because the peer's event is processed normally
    /// (no suppression to eat it). Rename/delete/write-existing keep their
    /// pre-write suppression — those disturb a file the watcher already knows.
    fn install_new(
        &self,
        wanted: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<NoteMetadata, String> {
        for _ in 0..1000 {
            let id = paths::unique_note_id(&self.root, wanted, None)?;
            let path = paths::note_path(&self.root, &id)?;
            #[cfg(test)]
            if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
                hook(&id);
            }
            if !create_new_atomic(&path, content.as_bytes())? {
                // A writer outside this store's serialization took the id; the
                // write did not happen. Re-allocate against the now-larger tree
                // and retry — no suppression to unwind.
                continue;
            }
            if let Some(modified_ms) = modified_ms.filter(|value| *value >= 0) {
                set_file_mtime_ms(&path, modified_ms)?;
            }
            let metadata = vault::metadata(&self.root, &id)
                .ok_or_else(|| "note metadata unavailable after create".to_owned())?;
            self.notify(&FileChange::Changed(note_filename(&id)));
            return Ok(metadata);
        }
        Err("could not allocate a free note id after repeated collisions".to_owned())
    }

    /// Park a divergent recovered backup (see
    /// `futo_notes_core::files::recover_parked_backups`) as a visible
    /// "<title> (recovered)" note through the no-replace create path, then
    /// consume the backup file. This is a NEW note — it never overwrites the
    /// live note holding the original name, and the terminal backup can never
    /// resurrect a later-deleted note (C1).
    fn park_recovered_backup(
        &self,
        recovered: &futo_notes_core::files::RecoveredBackup,
    ) -> Result<(), String> {
        // Folder = the backup's directory relative to the vault root, so a
        // recovered note in a subfolder stays in that subfolder (D4).
        let folder = recovered
            .backup
            .parent()
            .and_then(|parent| parent.strip_prefix(&self.root).ok())
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let title = futo_notes_core::files::note_id_from_filename(&recovered.leaf)
            .unwrap_or_else(|| recovered.leaf.clone());
        let stem = format!("{title} (recovered)");
        let wanted = make_id(&folder, &stem);
        // Idempotency (E2): a crash after the install but before the backup
        // unlink leaves the recovered note in place with the backup still
        // sidecar'd, so a re-sweep would re-park it under the next suffix —
        // a duplicate per interruption. If a note in this folder already holds
        // this backup's content under the recovered stem, the park already
        // landed; just finish the interrupted cleanup. (Content identity, not
        // inode nlink, so it holds on Windows too; mirrors the Swift
        // parkConflictCopyIfAbsent guard.)
        let backup_content = fs::read_to_string(&recovered.backup).map_err(io_error)?;
        let already_parked = vault::note_paths(&self.root).into_iter().any(|(id, _)| {
            let (id_folder, id_title) = split_id(&id);
            // Only a note this park could have produced — the exact stem or its
            // numeric collision suffix — counts, NOT a merely similarly-named
            // note like "<stem> draft" that happens to share content (F1).
            id_folder == folder
                && paths::is_unique_variant(&stem, &id_title)
                && self.read(&id) == backup_content
        });
        if already_parked {
            // Drop the sidecar ONLY after the backup unlink succeeds. If the
            // unlink fails (Windows lock, dir perms), keep both and propagate so
            // the next bootstrap retries — never leave a sidecar-less, untracked
            // backup no sweep can clean (F2).
            fs::remove_file(&recovered.backup).map_err(io_error)?;
            let _ = fs::remove_file(&recovered.sidecar);
            return Ok(());
        }
        // Park by moving the backup file itself to the recovered name — NO
        // read+create+delete (D1). But NO-REPLACE (E1, same TOCTOU class as A1
        // create / B2 restore): an external writer landing at the chosen
        // recovered name in the allocate→park window must not be clobbered.
        // `move_no_replace` reports Ok(false) rather than overwriting; on a taken
        // name re-suffix and retry. Installing the backup makes it terminal (it is
        // no longer a `.sf-bak-*` the restore loop could resurrect — C1) and
        // consumes the backup to complete the move, then the sidecar goes last so a crash mid-
        // park re-sweeps rather than strands.
        for _ in 0..1000 {
            let id = paths::unique_note_id(&self.root, &wanted, None)?;
            let path = paths::note_path(&self.root, &id)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(io_error)?;
            }
            #[cfg(test)]
            if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
                hook(&id);
            }
            match move_no_replace(&recovered.backup, &path) {
                Ok(true) => {
                    let _ = fs::remove_file(&recovered.sidecar);
                    self.notify(&FileChange::Changed(note_filename(&id)));
                    return Ok(());
                }
                Ok(false) => continue,
                Err(error) => return Err(error),
            }
        }
        Err("could not allocate a recovered note id after repeated collisions".to_owned())
    }

    /// The id of a DIFFERENT live note sharing `id`'s cross-platform collision
    /// key (case-insensitive + NFC), if any. `create_new_atomic` /
    /// `write_atomic_text` only catch an EXACT-path collision, so on a
    /// case-sensitive filesystem an install at `id` could otherwise shadow a
    /// live note cross-platform. `write_raw` refuses such a write; the flush
    /// verb's recreate and park arms park the draft instead of installing a
    /// shadowing id.
    fn colliding_note(&self, id: &str) -> Option<String> {
        vault::note_paths(&self.root)
            .into_iter()
            .map(|(existing, _)| existing)
            .find(|existing| collides_but_differs(existing, id))
    }

    fn write_raw(
        &self,
        id: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<NoteMetadata, String> {
        if let Some(existing) = self.colliding_note(id) {
            return Err(format!(
                "note id collides with existing cross-platform path: {existing}"
            ));
        }
        let path = paths::note_path(&self.root, id)?;
        let change = FileChange::Changed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        write_atomic_text(&path, content)?;
        if let Some(modified_ms) = modified_ms.filter(|value| *value >= 0) {
            set_file_mtime_ms(&path, modified_ms)?;
        }
        let metadata = vault::metadata(&self.root, id)
            .ok_or_else(|| "note metadata unavailable after write".to_owned())?;
        self.notify(&change);
        Ok(metadata)
    }

    fn migrate_text_files(&self) -> (u32, Vec<String>) {
        let sentinel = match safe_appdata_path(&self.root, ".txt-migration-done") {
            Ok(path) => path,
            Err(error) => return (0, vec![error]),
        };
        if sentinel.exists() {
            return (0, Vec::new());
        }
        let mut warnings = Vec::new();
        let mut migrated = 0;
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(error) => return (0, vec![io_error(error)]),
        };
        let mut names = entries
            .iter()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let mut occupied = names
            .iter()
            .map(|name| name.to_lowercase())
            .collect::<HashSet<_>>();
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !entry.path().is_file() || !name.to_lowercase().ends_with(".txt") {
                continue;
            }
            let stem = &name[..name.len() - 4];
            let mut target = format!("{stem}.md");
            if occupied.contains(&target.to_lowercase()) {
                target = format!("{stem} (imported).md");
                for suffix in 2u64.. {
                    if !occupied.contains(&target.to_lowercase()) && !names.contains(&target) {
                        break;
                    }
                    target = format!("{stem} (imported {suffix}).md");
                }
            }
            let source = entry.path();
            let destination = self.root.join(&target);
            let change = FileChange::Renamed {
                from: name.clone(),
                to: target.clone(),
            };
            self.before_write
                .before_write(std::slice::from_ref(&change));
            match rename_through_temp(&source, &destination) {
                Ok(()) => {
                    migrated += 1;
                    occupied.insert(target.to_lowercase());
                    names.push(target);
                    self.notify(&change);
                }
                Err(error) => warnings.push(format!("{name}: {error}")),
            }
        }
        if let Err(error) = write_atomic_text(&sentinel, "1") {
            warnings.push(format!("migration sentinel: {error}"));
        }
        (migrated, warnings)
    }

    fn notify(&self, change: &FileChange) {
        let Ok(search) = self.search.lock() else {
            return;
        };
        let Some(engine) = search.engine.as_ref() else {
            return;
        };
        match change {
            FileChange::Changed(path) => engine.notify_changed(path.clone()),
            FileChange::Removed(path) => engine.notify_removed(path.clone()),
            FileChange::Renamed { from, to } => engine.notify_renamed(from.clone(), to.clone()),
        }
    }

    fn lock_gate(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.gate
            .lock()
            .map_err(|_| "vault mutation lock poisoned".to_owned())
    }

    #[cfg(test)]
    fn set_install_window_hook(&self, hook: InstallWindowHook) {
        *self.install_window_hook.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn search_engine_installed(&self) -> bool {
        self.search.lock().unwrap().engine.is_some()
    }

    /// Test seam: clear the failure timestamp so the next search/status/rescan
    /// treats the retry cooldown as elapsed (deterministic, no wall-clock wait).
    #[cfg(test)]
    fn expire_search_retry_cooldown(&self) {
        self.search.lock().unwrap().last_start_failure = None;
    }
}

fn note_filename(id: &str) -> String {
    format!("{id}.md")
}

fn note_title(filename: &str) -> String {
    filename
        .strip_suffix(".md")
        .unwrap_or(filename)
        .to_owned()
}

fn join_id(folder: &str, title: &str) -> String {
    if folder.is_empty() {
        title.to_owned()
    } else {
        format!("{folder}/{title}")
    }
}

/// Whether `candidate` is a title [`LocalNoteStore::park_conflict_draft`]
/// could have minted for the dated `stem` ("<base> (conflict YYYY-MM-DD)"):
/// the stem itself or one of the naming rule's counter variants
/// ("<base> (conflict YYYY-MM-DD N)"). Deliberately NOT a prefix match, so a
/// merely similarly-named user note ("<stem> draft") never satisfies the park
/// idempotency guard (the F1 class).
fn is_dated_conflict_variant(stem: &str, candidate: &str) -> bool {
    if candidate == stem {
        return true;
    }
    let Some(open) = stem.strip_suffix(')') else {
        return false;
    };
    candidate
        .strip_prefix(open)
        .and_then(|rest| rest.strip_prefix(' '))
        .and_then(|rest| rest.strip_suffix(')'))
        .is_some_and(|counter| {
            !counter.is_empty() && counter.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn prepare_relinks(root: &Path, mappings: &[(String, String)]) -> HashMap<String, String> {
    if mappings.is_empty() {
        return HashMap::new();
    }
    let original = vault::bodies(root);
    let mut bodies = original.clone();
    let mut ids = original.keys().cloned().collect::<Vec<_>>();
    for (old, new) in mappings {
        for body in bodies.values_mut() {
            if !body.contains("[[") {
                continue;
            }
            let (rewritten, count) = rewrite_wikilinks(body, old, new, &ids);
            if count > 0 {
                *body = rewritten;
            }
        }
        if let Some(position) = ids.iter().position(|id| id == old) {
            ids[position] = new.clone();
        }
    }
    let final_ids = mappings.iter().cloned().collect::<HashMap<_, _>>();
    bodies
        .into_iter()
        .filter_map(|(old_id, body)| {
            (original.get(&old_id) != Some(&body)).then(|| {
                let id = final_ids.get(&old_id).cloned().unwrap_or(old_id);
                (id, body)
            })
        })
        .collect()
}

fn rename_changes(mappings: &[(String, String)]) -> Vec<FileChange> {
    mappings
        .iter()
        .map(|(from, to)| FileChange::Renamed {
            from: note_filename(from),
            to: note_filename(to),
        })
        .collect()
}

fn move_files_with_rollback(root: &Path, mappings: &[(String, String)]) -> Result<(), String> {
    let mut completed: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (from, to) in mappings {
        let source = paths::note_path(root, from)?;
        let destination = paths::note_path(root, to)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let result = if collides_but_differs(from, to) {
            rename_through_temp(&source, &destination)
        } else {
            // No-replace move. The destination id was allocated unique, so a
            // file there now is a writer outside this store's serialization —
            // never clobber it (the A1 window applied to rename). `move_no_replace`
            // is the portable atomic no-replace install (Ok(false) if taken),
            // carries mtime across, and consumes the source to complete the move;
            // on a collision the caller rolls back — the newcomer and the source
            // both survive.
            match move_no_replace(&source, &destination) {
                Ok(true) => Ok(()),
                Ok(false) => Err(format!(
                    "rename destination {} appeared under a concurrent writer",
                    destination.display()
                )),
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            for (original, moved) in completed.into_iter().rev() {
                let _ = fs::rename(moved, original);
            }
            return Err(error);
        }
        completed.push((source, destination));
    }
    for (source, _) in &completed {
        prune_empty_parents(root, source);
    }
    Ok(())
}

fn prune_empty_parents(root: &Path, note_path: &Path) {
    let Some(mut directory) = note_path.parent().map(Path::to_owned) else {
        return;
    };
    while directory != root && directory.starts_with(root) {
        let empty = fs::read_dir(&directory)
            .ok()
            .and_then(|mut entries| entries.next())
            .is_none();
        if !empty || fs::remove_dir(&directory).is_err() {
            return;
        }
        let Some(parent) = directory.parent() else {
            return;
        };
        directory = parent.to_owned();
    }
}

fn same_physical(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left)
        .ok()
        .zip(fs::canonicalize(right).ok())
        .map(|(left, right)| left == right)
        .unwrap_or(false)
}

fn remove_empty_source_warning(path: &Path) -> Vec<String> {
    if path.exists() {
        vec![format!("old folder remains at {}", path.display())]
    } else {
        Vec::new()
    }
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests;
