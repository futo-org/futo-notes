//! One durable owner for the local Markdown vault and its derived search index.

mod bootstrap;
mod commit;
mod editor_draft;
mod flush;
mod folders;
mod list_cache;
mod notes;
mod paths;
mod relink;
mod search;
mod vault;
mod vault_migration;
mod welcome_seed;

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use futo_notes_core::files::{vault_fs, vault_mutation_guard};
use futo_notes_model::{make_id, sanitize_folder_path, split_id};
use futo_notes_search::StatusObserver;
use serde::{Deserialize, Serialize};

use search::StoreSearch;

pub use futo_notes_model::{WELCOME_NOTE, WELCOME_NOTE_ID};
pub use futo_notes_search::{SearchHit, SearchStatus};
pub use vault_migration::{
    VaultDestinationInspection, VaultDestinationState, VaultMigrationFinalization,
    VaultMigrationOutcome, VaultMigrationStatus,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteSortKey {
    #[default]
    LastModified,
    Name,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Ascending,
    #[default]
    Descending,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSortOrder {
    pub key: NoteSortKey,
    pub direction: SortDirection,
}

/// Whether a path names a supported Markdown source, independent of whether it
/// currently exists. Shared by OS-open routing and the import workflow so the
/// shell cannot advertise a file the store will later reject.
pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

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

/// Content-free note-list projection for latency-sensitive shell startup.
/// The engine still owns ordering; shells hydrate previews and tags from a
/// full [`Snapshot`] after the usable title list is visible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListingMetadata {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingSnapshot {
    pub notes: Vec<NoteListingMetadata>,
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
    /// Collision-resolved folder path for rename/move-folder workflows.
    pub final_folder: Option<String>,
    /// Final ids of the notes whose body this workflow's backlink rewrite
    /// changed on disk. An editor holding one of them holds bytes that are no
    /// longer the file's, from a change its own user made: it adopts the file
    /// rather than treating the difference as a peer's edit.
    #[serde(default)]
    pub relinked: Vec<String>,
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

#[cfg(test)]
type InstallWindowHook = Box<dyn Fn(&str) + Send + Sync>;

/// One instance owns one vault. Every mutation is serialized through `gate`,
/// so conditional writes and multi-file rename/relink operations have a
/// single-process decision boundary shared by all shells.
pub struct LocalNoteStore {
    root: PathBuf,
    before_write: Arc<dyn BeforeWrite>,
    gate: Mutex<()>,
    sort_order: Mutex<NoteSortOrder>,
    search: StoreSearch,
    list_cache: list_cache::ListCache,
    /// Index dir of the last `bootstrap_with_search`: where the Welcome-seeded
    /// marker lives, so a full reset can clear it.
    app_data_index: Mutex<Option<PathBuf>>,
    /// Fault injection fired between id allocation and no-replace installation
    /// to simulate a concurrent writer landing at the chosen id.
    #[cfg(test)]
    install_window_hook: Mutex<Option<InstallWindowHook>>,
    /// Fault injection fired after a flush reads the base and while it still
    /// owns the process-wide check/write span.
    #[cfg(test)]
    flush_window_hook: Mutex<Option<InstallWindowHook>>,
}

impl LocalNoteStore {
    pub fn new(root: PathBuf) -> Self {
        Self::with_before_write(root, Arc::new(NoopBeforeWrite))
    }

    pub fn with_before_write(root: PathBuf, before_write: Arc<dyn BeforeWrite>) -> Self {
        Self {
            search: StoreSearch::new(root.clone()),
            root,
            before_write,
            gate: Mutex::new(()),
            sort_order: Mutex::new(NoteSortOrder::default()),
            list_cache: list_cache::ListCache::new(),
            app_data_index: Mutex::new(None),
            #[cfg(test)]
            install_window_hook: Mutex::new(None),
            #[cfg(test)]
            flush_window_hook: Mutex::new(None),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn sort_order(&self) -> NoteSortOrder {
        *self
            .sort_order
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn install_sort_order(&self, order: NoteSortOrder) {
        *self
            .sort_order
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = order;
    }

    pub fn set_sort_order(&self, order: NoteSortOrder) -> Result<Snapshot, String> {
        let _gate = self.lock_gate()?;
        self.install_sort_order(order);
        Ok(vault::snapshot_with_cache(
            &self.root,
            &self.list_cache,
            order,
        ))
    }

    /// Independent of the active sort order; stat-only, never reads a body.
    pub fn recent_note_ids(&self, limit: usize) -> Vec<String> {
        let mut ids = vault::note_order_and_folders(&self.root, NoteSortOrder::default()).0;
        ids.truncate(limit);
        ids
    }

    pub fn startup_listing_in_order(
        &self,
        order: NoteSortOrder,
        cached: Option<ListingSnapshot>,
    ) -> Result<ListingSnapshot, String> {
        let _gate = self.lock_gate()?;
        self.install_sort_order(order);
        Ok(match cached {
            Some(mut listing) => {
                vault::sort_listing(order, &mut listing.notes);
                listing
            }
            None => vault::listing(&self.root, order),
        })
    }

    /// Starts reconciliation in the search engine's background runtime. The
    /// caller is expected to invoke this off the UI thread; note-list startup
    /// never waits for keyword readiness.
    pub fn start_search(
        &self,
        index_dir: PathBuf,
        on_status: StatusObserver,
    ) -> Result<(), String> {
        self.search.start(index_dir, on_status)
    }

    pub fn search(&self, query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
        self.search.query(query, limit)
    }

    /// Blocking, bounded wait for engine-owned search readiness. Callers keep
    /// it off the UI thread; a timeout safely degrades to empty search results
    /// while the index continues its self-healing retries.
    pub fn wait_until_search_ready(&self, timeout_ms: u64) -> bool {
        self.search.wait_until_ready(timeout_ms)
    }

    pub fn rebuild_search(&self) {
        self.search.rebuild();
    }

    pub fn observe_external_change(&self, change: FileChange) {
        self.search.notify(&change);
    }

    /// Destructive local reset. Session/sync shutdown ordering remains a shell
    /// responsibility; once called, this removes every vault entry, including
    /// images and hidden app-data, and reconciles search from the empty tree.
    pub fn reset(&self) -> Result<(), String> {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let removals = vault::note_paths(&self.root)
            .into_iter()
            .map(|(id, _)| FileChange::Removed(note_filename(&id)))
            .collect::<Vec<_>>();
        self.before_write.before_write(&removals);
        vault_fs::clear(&self.root)?;
        // A reset app is a fresh install: the next launch shows Welcome once
        // more. Best effort - a stuck marker only withholds the greeting.
        if let Some(index_dir) = self
            .app_data_index
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref()
        {
            let _ = welcome_seed::mark_reseed(index_dir);
        }
        self.rebuild_search();
        Ok(())
    }

    /// Reports what a candidate notes folder already holds. Read-only: the
    /// shell migrates into an empty folder and opens an occupied one instead of
    /// merging, so nothing here mutates either vault.
    pub fn inspect_vault_destination(&self, destination: &Path) -> VaultDestinationInspection {
        vault_migration::inspect(&self.root, destination)
    }

    /// Stages a verified whole-vault copy while keeping the source intact.
    pub fn stage_vault_migration(
        &self,
        destination: &Path,
    ) -> Result<VaultMigrationOutcome, String> {
        let _gate = self.lock_gate()?;
        vault_migration::stage(&self.root, destination)
    }

    /// Deletes the source vault only when the shell can exclude external writers.
    pub fn finalize_vault_migration(
        &self,
        destination: &Path,
        allow_source_removal: bool,
    ) -> Result<VaultMigrationFinalization, String> {
        let _gate = self.lock_gate()?;
        vault_migration::finalize(&self.root, destination, allow_source_removal)
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
    fn set_flush_window_hook(&self, hook: InstallWindowHook) {
        *self.flush_window_hook.lock().unwrap() = Some(hook);
    }
}

fn note_filename(id: &str) -> String {
    format!("{id}.md")
}

fn note_title(filename: &str) -> String {
    filename.strip_suffix(".md").unwrap_or(filename).to_owned()
}

fn join_id(folder: &str, title: &str) -> String {
    if folder.is_empty() {
        title.to_owned()
    } else {
        format!("{folder}/{title}")
    }
}

/// `path`'s vault name (`vault_fs::relative_name`), or an error naming the
/// path when it has none.
fn vault_name(root: &Path, path: &Path) -> Result<String, String> {
    vault_fs::relative_name(root, path)
        .ok_or_else(|| format!("no vault name for {}", path.display()))
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
mod test_support;

#[cfg(test)]
mod tests;
