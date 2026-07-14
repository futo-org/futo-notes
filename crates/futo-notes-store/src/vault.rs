use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{file_mtime_ms, note_id_from_relative_path, safe_note_path};
use futo_notes_model::{make_preview, make_rich_preview, note_tags, split_id};
use rayon::prelude::*;
use walkdir::{DirEntry, WalkDir};

use crate::{NoteMetadata, Snapshot, VaultFile};

pub(crate) fn snapshot(root: &Path) -> Snapshot {
    let (paths, folders) = walk(root);
    let mut notes: Vec<NoteMetadata> = paths
        .into_par_iter()
        .filter_map(|(id, path)| metadata_at(&id, &path))
        .collect();
    notes.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    Snapshot {
        notes,
        folders: folders.into_iter().collect(),
    }
}

pub(crate) fn note_paths(root: &Path) -> Vec<(String, PathBuf)> {
    walk(root).0
}

pub(crate) fn bodies(root: &Path) -> HashMap<String, String> {
    note_paths(root)
        .into_iter()
        .map(|(id, path)| (id, fs::read_to_string(path).unwrap_or_default()))
        .collect()
}

pub(crate) fn metadata(root: &Path, id: &str) -> Option<NoteMetadata> {
    let path = safe_note_path(root, id).ok()?;
    metadata_at(id, &path)
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

fn metadata_at(id: &str, path: &Path) -> Option<NoteMetadata> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let content = fs::read_to_string(path).unwrap_or_default();
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
