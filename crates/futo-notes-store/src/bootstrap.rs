//! Launch: the vault bootstrap, the one-time `.txt` migration, and welcome seeding.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::PoisonError;

use futo_notes_core::files::{
    safe_appdata_path, vault_fs, vault_mutation_guard, write_atomic_text,
};
use futo_notes_model::{WELCOME_NOTE, WELCOME_NOTE_ID};
use futo_notes_search::StatusObserver;

use crate::{
    io_error, list_cache, vault, welcome_seed, BootstrapResult, FileChange, ListingSnapshot,
    LocalNoteStore, NoteSortOrder,
};

impl LocalNoteStore {
    pub fn bootstrap(&self) -> Result<BootstrapResult, String> {
        self.bootstrap_loading(None)
    }

    /// `cache`, when given, is the (canonical root, index dir) of the persisted
    /// list cache, loaded while crash recovery runs: entries are stat-checked,
    /// so a concurrent recovery rename can only cost a miss.
    fn bootstrap_loading(&self, cache: Option<(&Path, &Path)>) -> Result<BootstrapResult, String> {
        let _gate = self.lock_gate()?;
        // `None` (no app-data dir to persist in): seeds whenever the vault is empty.
        let index_dir = cache.map(|(_, index_dir)| index_dir);
        let may_seed = index_dir.is_none_or(welcome_seed::may_seed);
        let (migrated, mut warnings) = std::thread::scope(|scope| {
            if let Some((root, index_dir)) = cache {
                scope.spawn(|| self.list_cache.ensure_disk_loaded(root, index_dir));
            }
            self.prepare_bootstrap()
        })?;
        let mut snapshot = self.snapshot();
        let wants_seed = may_seed && snapshot.notes.is_empty();
        let seeded = self.seed_empty_vault(wants_seed, &mut warnings);
        if seeded == 1 {
            snapshot = self.snapshot();
        }
        // A failed seed is retried next launch; every other outcome is final.
        if let Some(index_dir) = index_dir.filter(|_| seeded == 1 || !wants_seed) {
            if let Err(error) = welcome_seed::mark_seeded(index_dir) {
                warnings.push(format!("welcome marker: {error}"));
            }
        }
        Ok(BootstrapResult {
            snapshot,
            seeded,
            migrated,
            warnings,
        })
    }

    /// Read-only, content-free projection for the first desktop list frame.
    /// The authoritative bootstrap immediately follows it and still owns crash
    /// recovery, migration, empty-vault seeding, and content-derived metadata.
    pub fn startup_listing(&self) -> ListingSnapshot {
        vault::listing(&self.root, self.sort_order())
    }

    /// Recover crash leftovers before migration/scan/seed so a stranded real
    /// note can never be mistaken for an empty vault (A2/C1).
    fn prepare_bootstrap(&self) -> Result<(u32, Vec<String>), String> {
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let mut warnings = Vec::new();
        for recovered in futo_notes_core::files::recover_parked_backups(&self.root) {
            if let Err(error) = self.park_recovered_backup(&recovered) {
                warnings.push(format!("recovered note {}: {error}", recovered.leaf));
            }
        }
        let (migrated, migrate_warnings) = self.migrate_text_files();
        warnings.extend(migrate_warnings);
        Ok((migrated, warnings))
    }

    fn seed_empty_vault(&self, wanted: bool, warnings: &mut Vec<String>) -> u32 {
        if !wanted {
            return 0;
        }
        match vault_mutation_guard()
            .and_then(|_vault_mutation| self.write_raw(WELCOME_NOTE_ID, WELCOME_NOTE, None))
        {
            Ok(_) => 1,
            Err(error) => {
                warnings.push(format!("welcome note: {error}"));
                0
            }
        }
    }

    /// Bootstrap the vault, then start the owned search index in the background
    /// as a BEST-EFFORT step: a search-start failure is recorded as a warning,
    /// never fatal, so the note list always renders even when the index can't
    /// open (the search lifecycle retries later after its cooldown).
    /// The single rule every adapter's bootstrap shares, so no shell can make
    /// search startup gate the vault (A3).
    pub fn bootstrap_with_search(
        &self,
        index_dir: PathBuf,
        on_status: StatusObserver,
    ) -> Result<BootstrapResult, String> {
        let root = list_cache::canonicalize_or(&self.root);
        *self
            .app_data_index
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(index_dir.clone());
        let mut result = self.bootstrap_loading(Some((&root, &index_dir)))?;
        if let Err(error) = self.start_search(index_dir, on_status) {
            result.warnings.push(format!("search startup: {error}"));
        }
        Ok(result)
    }

    pub fn bootstrap_with_search_in_order(
        &self,
        order: NoteSortOrder,
        index_dir: PathBuf,
        on_status: StatusObserver,
    ) -> Result<BootstrapResult, String> {
        self.install_sort_order(order);
        self.bootstrap_with_search(index_dir, on_status)
    }
}

impl LocalNoteStore {
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
            if !entry.file_type().is_ok_and(|kind| kind.is_file())
                || !name.to_lowercase().ends_with(".txt")
            {
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
            let change = FileChange::Renamed {
                from: name.clone(),
                to: target.clone(),
            };
            self.before_write
                .before_write(std::slice::from_ref(&change));
            match vault_fs::move_no_replace(&self.root, &name, &target) {
                Ok(true) => {
                    migrated += 1;
                    occupied.insert(target.to_lowercase());
                    names.push(target);
                    self.search.notify(&change);
                }
                Ok(false) => warnings.push(format!(
                    "{name}: migration destination appeared concurrently"
                )),
                Err(error) => warnings.push(format!("{name}: {error}")),
            }
        }
        if let Err(error) = write_atomic_text(&sentinel, "1") {
            warnings.push(format!("migration sentinel: {error}"));
        }
        (migrated, warnings)
    }
}
