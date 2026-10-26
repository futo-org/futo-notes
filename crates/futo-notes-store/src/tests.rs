use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::test_support::TestRoot;
use futo_notes_core::conflict_names::current_conflict_date;
use futo_notes_core::files::{file_mtime_ms, set_file_mtime_ms};

#[derive(Default)]
struct RecordingObserver(Mutex<Vec<Vec<FileChange>>>);

impl BeforeWrite for RecordingObserver {
    fn before_write(&self, changes: &[FileChange]) {
        self.0.lock().unwrap().push(changes.to_vec());
    }
}

fn store(root: &TestRoot) -> LocalNoteStore {
    LocalNoteStore::new(root.0.clone())
}

/// Plant a file at the chosen id exactly once, via the install-window hook —
/// simulating a concurrent external/sync writer landing at the id between
/// allocation and the no-replace install.
fn plant_once(root: &TestRoot, content: &'static str) -> Box<dyn Fn(&str) + Send + Sync> {
    let dir = root.0.clone();
    let planted = Mutex::new(false);
    Box::new(move |id: &str| {
        let mut done = planted.lock().unwrap();
        if !*done {
            fs::write(dir.join(format!("{id}.md")), content).unwrap();
            *done = true;
        }
    })
}

fn ids_in_order(store: &LocalNoteStore) -> Vec<String> {
    store
        .snapshot()
        .notes
        .into_iter()
        .map(|note| note.id)
        .collect()
}

fn apply_as_shell(list: &[String], mutation: &MutationResult) -> Vec<String> {
    let affected: HashSet<&str> = mutation
        .removed
        .iter()
        .map(String::as_str)
        .chain(mutation.upserted.iter().map(|entry| entry.note.id.as_str()))
        .collect();
    let mut next: Vec<String> = list
        .iter()
        .filter(|id| !affected.contains(id.as_str()))
        .cloned()
        .collect();
    for entry in &mutation.upserted {
        let position = (entry.position as usize).min(next.len());
        next.insert(position, entry.note.id.clone());
    }
    next
}

/// What an open returns with no cache: every note read and derived.
fn uncached(root: &TestRoot) -> Snapshot {
    crate::vault::snapshot_with_cache(
        &root.0,
        &crate::list_cache::ListCache::new(),
        NoteSortOrder::default(),
    )
}

mod append;
mod bootstrap;
mod create_and_recovery;
mod external_changes;
mod flush_draft;
mod flush_draft_parking;
mod modified_times;
mod rename_and_folders;
mod reset_and_migration;
mod sort_order;
mod unsafe_paths;
mod vault_walk;
