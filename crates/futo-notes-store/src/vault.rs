use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{
    collision_key, file_mtime_ms, note_id_from_relative_path, safe_note_path, vault_fs,
};
use futo_notes_model::{make_preview, make_rich_preview, note_tags, split_id};
use rayon::prelude::*;
use walkdir::{DirEntry, WalkDir};

use crate::{ListingSnapshot, NoteListingMetadata, NoteMetadata, Snapshot, VaultFile};

/// THE note-list sort rule (modified desc, id asc). Canonical for every shell:
/// snapshots are emitted in this order and mutations carry each upserted note's
/// position in it, so no shell holds a sort rule of its own (ADR-0001).
pub(crate) fn note_list_order(left: (i64, &str), right: (i64, &str)) -> std::cmp::Ordering {
    right.0.cmp(&left.0).then_with(|| left.1.cmp(right.1))
}

pub(crate) fn snapshot(root: &Path) -> Snapshot {
    let (paths, folders) = walk(root);
    let mut notes: Vec<NoteMetadata> = paths
        .into_par_iter()
        .filter_map(|(id, path)| metadata_at(root, &id, &path))
        .collect();
    notes.sort_by(|left, right| {
        note_list_order((left.modified_ms, &left.id), (right.modified_ms, &right.id))
    });
    Snapshot {
        notes,
        folders: folders.into_iter().collect(),
    }
}

pub(crate) fn listing(root: &Path) -> ListingSnapshot {
    let (paths, folders) = walk(root);
    let mut notes = paths
        .into_iter()
        .filter_map(|(id, path)| {
            let metadata = fs::metadata(path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            let (folder, title) = split_id(&id);
            Some(NoteListingMetadata {
                id,
                title,
                folder,
                modified_ms: file_mtime_ms(&metadata),
            })
        })
        .collect::<Vec<_>>();
    notes.sort_by(|left, right| {
        note_list_order((left.modified_ms, &left.id), (right.modified_ms, &right.id))
    });
    ListingSnapshot {
        notes,
        folders: folders.into_iter().collect(),
    }
}

/// Stat-only post-mutation projection used to assign note positions and return
/// the same folder state to every shell.
pub(crate) fn note_order_and_folders(root: &Path) -> (Vec<String>, Vec<String>) {
    let (paths, folders) = walk(root);
    let mut entries: Vec<(i64, String)> = paths
        .into_iter()
        .filter_map(|(id, path)| {
            let metadata = fs::metadata(path).ok()?;
            metadata.is_file().then(|| (file_mtime_ms(&metadata), id))
        })
        .collect();
    entries.sort_by(|left, right| note_list_order((left.0, &left.1), (right.0, &right.1)));
    (
        entries.into_iter().map(|(_, id)| id).collect(),
        folders.into_iter().collect(),
    )
}

pub(crate) fn note_paths(root: &Path) -> Vec<(String, PathBuf)> {
    walk(root).0
}

/// Every note id that can collide with `wanted` under `collision_key` — the
/// case- and NFC-folded equality every cross-platform collision check uses.
///
/// A colliding id has the same number of `/` components as `wanted`, and each
/// leading path prefix folds to the same key (`collision_key` never composes
/// or case-folds across a `/`). So only directories whose folded relative path
/// matches the corresponding prefix of `wanted` can hold one, and the walk
/// prunes every other subtree at the directory level. Same traversal rules as
/// [`walk`] (hidden entries skipped, depth-capped, symlinks not followed, the
/// same `.md`/safe-id filter), so the returned set is exactly the subset of
/// [`note_paths`] a full-vault filter would have kept.
///
/// This is on the autosave path (`write_raw` refuses a folded collision before
/// every write, `install_new` allocates a unique id), where the full walk it
/// replaces cost more than reading the entire vault: 30 directory reads plus
/// one folded key per note, per save, against one or two directory reads here.
pub(crate) fn collision_candidates(root: &Path, wanted: &str) -> Vec<String> {
    if !root.exists() {
        return Vec::new();
    }
    let components: Vec<&str> = wanted.split('/').collect();
    let note_depth = components.len();
    // prefix_keys[d] is the folded key a directory at depth d must match.
    let prefix_keys: Vec<String> = (1..note_depth)
        .map(|depth| collision_key(&components[..depth].join("/")))
        .collect();
    let relative_of = |entry: &DirEntry| -> Option<String> {
        let relative = entry.path().strip_prefix(root).ok()?;
        Some(relative.to_string_lossy().replace('\\', "/"))
    };
    let mut ids = Vec::new();
    let entries = WalkDir::new(root)
        .follow_links(false)
        .max_depth(note_depth)
        .into_iter()
        .filter_entry(|entry| {
            if !visible(entry) {
                return false;
            }
            let depth = entry.depth();
            if depth == 0 {
                return true;
            }
            if entry.file_type().is_dir() {
                return depth < note_depth
                    && relative_of(entry).is_some_and(|relative| {
                        collision_key(&relative) == prefix_keys[depth - 1]
                    });
            }
            depth == note_depth
        });
    for entry in entries.filter_map(Result::ok) {
        if entry.depth() != note_depth || !entry.file_type().is_file() {
            continue;
        }
        if let Some(id) =
            relative_of(&entry).and_then(|relative| note_id_from_relative_path(&relative))
        {
            ids.push(id);
        }
    }
    ids
}

pub(crate) fn bodies(root: &Path) -> HashMap<String, String> {
    note_paths(root)
        .into_iter()
        .filter_map(|(id, _)| {
            let bytes = vault_fs::read(root, &format!("{id}.md")).ok()?;
            Some((id, String::from_utf8_lossy(&bytes).into_owned()))
        })
        .collect()
}

pub(crate) fn metadata(root: &Path, id: &str) -> Option<NoteMetadata> {
    let path = safe_note_path(root, id).ok()?;
    metadata_at(root, id, &path)
}

pub(crate) fn inventory(root: &Path) -> Vec<VaultFile> {
    let mut files: Vec<VaultFile> = note_paths(root)
        .into_iter()
        .filter_map(|(id, path)| {
            let metadata = fs::metadata(path).ok()?;
            Some(VaultFile {
                name: format!("{id}.md"),
                mtime_ms: file_mtime_ms(&metadata),
                size_bytes: metadata.len(),
            })
        })
        .collect();
    files.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.name.cmp(&right.name))
    });
    files
}

fn metadata_at(root: &Path, id: &str, path: &Path) -> Option<NoteMetadata> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let bytes = vault_fs::read(root, &format!("{id}.md")).ok()?;
    let content = String::from_utf8_lossy(&bytes);
    let (folder, title) = split_id(id);
    Some(NoteMetadata {
        id: id.to_owned(),
        title,
        folder,
        modified_ms: file_mtime_ms(&metadata),
        preview: make_preview(&content),
        rich_preview: make_rich_preview(&content),
        tags: note_tags(&content),
    })
}

fn walk(root: &Path) -> (Vec<(String, PathBuf)>, BTreeSet<String>) {
    if !root.exists() {
        return (Vec::new(), BTreeSet::new());
    }
    let mut notes = Vec::new();
    let mut folders = BTreeSet::new();
    let entries = WalkDir::new(root)
        .follow_links(false)
        .max_depth(futo_notes_core::files::MAX_FOLDER_DEPTH + 1)
        .into_iter()
        .filter_entry(visible);
    for entry in entries.filter_map(Result::ok) {
        if entry.depth() == 0 {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            register_ancestors(&relative, &mut folders);
        } else if entry.file_type().is_file() {
            if let Some(id) = note_id_from_relative_path(&relative) {
                let (folder, _) = split_id(&id);
                register_ancestors(&folder, &mut folders);
                notes.push((id, entry.path().to_owned()));
            }
        }
    }
    (notes, folders)
}

fn visible(entry: &DirEntry) -> bool {
    entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
}

fn register_ancestors(folder: &str, folders: &mut BTreeSet<String>) {
    let mut current = String::new();
    for component in folder.split('/').filter(|part| !part.is_empty()) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(component);
        folders.insert(current.clone());
    }
}
