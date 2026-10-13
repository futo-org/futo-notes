//! The persisted fact that the Welcome note has already been offered, kept at
//! `<index_dir>.welcome` next to the search index (app data, never the vault:
//! users object to marker files in their notes folder).
//!
//! Without it, "the vault has no notes" reseeds Welcome on every launch after
//! the user deletes it. Absent means unknown: a first launch (no index yet)
//! may seed, while an install that predates this file already has an index
//! from its earlier launches and must not get Welcome back on upgrade.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::list_cache;

const SEEDED: &str = "seeded";
/// Written by a full reset so the next launch is a first launch again.
const RESEED: &str = "reseed";

pub(crate) fn marker_path(index_dir: &Path) -> PathBuf {
    let mut name = index_dir.file_name().unwrap_or_default().to_owned();
    name.push(".welcome");
    index_dir.with_file_name(name)
}

/// Read before this launch touches the index or list cache, which a launch
/// creates and which are the "launched before" signal for a missing marker.
pub(crate) fn may_seed(index_dir: &Path) -> bool {
    match fs::read_to_string(marker_path(index_dir)) {
        Ok(state) => state.trim() == RESEED,
        Err(error) if error.kind() == ErrorKind::NotFound => !launched_before(index_dir),
        Err(_) => false,
    }
}

fn launched_before(index_dir: &Path) -> bool {
    list_cache::cache_file_path(index_dir).exists()
        || fs::read_dir(index_dir).is_ok_and(|mut entries| entries.next().is_some())
}

pub(crate) fn mark_seeded(index_dir: &Path) -> std::io::Result<()> {
    write_marker(index_dir, SEEDED)
}

pub(crate) fn mark_reseed(index_dir: &Path) -> std::io::Result<()> {
    write_marker(index_dir, RESEED)
}

/// The marker's parent (iOS `Library/Application Support`) may not exist yet
/// on a true fresh install; writing without creating it fails with ENOENT.
fn write_marker(index_dir: &Path, state: &str) -> std::io::Result<()> {
    let marker = marker_path(index_dir);
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(marker, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestRoot;

    #[test]
    fn markers_are_written_into_a_parent_dir_that_does_not_exist_yet() {
        let root = TestRoot::new();
        let index = root.0.join("Library/Application Support/search");
        mark_seeded(&index).unwrap();
        assert_eq!(fs::read_to_string(marker_path(&index)).unwrap(), SEEDED);
        assert!(!may_seed(&index));

        let index = root.0.join("Other/Support/search");
        mark_reseed(&index).unwrap();
        assert!(may_seed(&index));
    }
}
