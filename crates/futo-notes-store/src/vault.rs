use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{
    collision_key, file_mtime_ms, note_id_from_relative_path, safe_note_path, vault_fs,
    MAX_FOLDER_DEPTH,
};
use futo_notes_model::{make_preview, make_rich_preview, note_tags, split_id};
use rayon::prelude::*;
use walkdir::{DirEntry, WalkDir};

use crate::list_cache::{self, Entry, Fingerprint, ListCache};
use crate::{
    ListingSnapshot, NoteListingMetadata, NoteMetadata, NoteSortKey, NoteSortOrder, Snapshot,
    SortDirection, VaultFile,
};

/// THE note-list sort rule (chosen key in the chosen direction, id asc). Canonical
/// for every shell: snapshots are emitted in this order and mutations carry each
/// upserted note's position in it, so no shell holds a sort rule of its own (ADR-0001).
pub(crate) fn note_list_order(
    order: NoteSortOrder,
    left: (i64, &str),
    right: (i64, &str),
) -> std::cmp::Ordering {
    let primary = match order.key {
        NoteSortKey::LastModified => left.0.cmp(&right.0),
        NoteSortKey::Name => collision_key(title_of(left.1)).cmp(&collision_key(title_of(right.1))),
    };
    let directed = match order.direction {
        SortDirection::Ascending => primary,
        SortDirection::Descending => primary.reverse(),
    };
    directed.then_with(|| left.1.cmp(right.1))
}

fn title_of(id: &str) -> &str {
    id.rsplit_once('/').map_or(id, |(_, title)| title)
}

pub(crate) fn sort_listing(order: NoteSortOrder, notes: &mut [NoteListingMetadata]) {
    notes.sort_by(|left, right| {
        note_list_order(
            order,
            (left.modified_ms, &left.id),
            (right.modified_ms, &right.id),
        )
    });
}

/// The full snapshot, reusing `cache`'s preview/rich preview/tags for every
/// note whose stat fingerprint is unchanged and older than the racy margin,
/// so an unchanged note is never read. Every note is still stat'd: sync
/// writes straight to disk.
pub(crate) fn snapshot_with_cache(
    root: &Path,
    cache: &ListCache,
    order: NoteSortOrder,
) -> Snapshot {
    let pass_started_ns = list_cache::now_ns();
    let (old, built_at_ns) = cache.current();
    let trusted_before_ns = built_at_ns.saturating_sub(list_cache::RACY_MARGIN_NS);
    let settled_before_ns = pass_started_ns.saturating_sub(list_cache::RACY_MARGIN_NS);
    let (resolved, folders) = walk_notes(root, |id, entry| {
        let metadata = entry.metadata().ok().filter(fs::Metadata::is_file)?;
        let fingerprint = Fingerprint::of(&metadata);
        let cached = old.get(&id);
        let hit = cached
            .as_ref()
            .filter(|cached| cached.fingerprint == fingerprint)
            .filter(|_| !fingerprint.is_racy(trusted_before_ns));
        let (preview, rich_preview, tags) = match hit {
            Some(cached) => cached.to_owned_fields(),
            None => {
                let bytes = vault_fs::read(root, &format!("{id}.md")).ok()?;
                derive(&decode_utf8_lossy(&bytes))
            }
        };
        // A racy re-read that lands on the same content is not a change, but
        // once it is outside the margin, persisting lets later launches hit it.
        let unchanged = hit.is_some()
            || cached
                .as_ref()
                .is_some_and(|cached| cached.same(fingerprint, &preview, &rich_preview, &tags));
        let promotable = hit.is_none() && unchanged && !fingerprint.is_racy(settled_before_ns);
        let (folder, title) = split_id(&id);
        let note = NoteMetadata {
            id,
            title,
            folder,
            modified_ms: file_mtime_ms(&metadata),
            preview,
            rich_preview,
            tags,
        };
        Some((note, fingerprint, unchanged, promotable))
    });
    let changed =
        resolved.len() != old.len() || resolved.iter().any(|(_, _, unchanged, _)| !unchanged);
    let promote =
        cache.is_disk_backed() && resolved.iter().any(|(_, _, _, promotable)| *promotable);
    let entries = (changed || promote).then(|| {
        resolved
            .par_iter()
            .map(|(note, fingerprint, _, _)| Entry::of(note, *fingerprint))
            .collect()
    });
    cache.commit(&list_cache::canonicalize_or(root), pass_started_ns, entries);
    let mut notes: Vec<NoteMetadata> = resolved.into_iter().map(|(note, ..)| note).collect();
    // Ids are unique, so the order is total and an unstable sort is exact.
    notes.par_sort_unstable_by(|left, right| {
        note_list_order(
            order,
            (left.modified_ms, &left.id),
            (right.modified_ms, &right.id),
        )
    });
    Snapshot {
        notes,
        folders: folders.into_iter().collect(),
    }
}

pub(crate) fn listing(root: &Path, order: NoteSortOrder) -> ListingSnapshot {
    let (mut notes, folders) = walk_notes(root, |id, entry| {
        let metadata = entry.metadata().ok().filter(fs::Metadata::is_file)?;
        let (folder, title) = split_id(&id);
        Some(NoteListingMetadata {
            id,
            title,
            folder,
            modified_ms: file_mtime_ms(&metadata),
        })
    });
    notes.par_sort_unstable_by(|left, right| {
        note_list_order(
            order,
            (left.modified_ms, &left.id),
            (right.modified_ms, &right.id),
        )
    });
    ListingSnapshot {
        notes,
        folders: folders.into_iter().collect(),
    }
}

/// Stat-only post-mutation projection used to assign note positions and return
/// the same folder state to every shell.
pub(crate) fn note_order_and_folders(
    root: &Path,
    order: NoteSortOrder,
) -> (Vec<String>, Vec<String>) {
    let (mut entries, folders) = walk_notes(root, |id, entry| {
        let metadata = entry.metadata().ok().filter(fs::Metadata::is_file)?;
        Some((file_mtime_ms(&metadata), id))
    });
    entries.par_sort_unstable_by(|left, right| {
        note_list_order(order, (left.0, &left.1), (right.0, &right.1))
    });
    (
        entries.into_iter().map(|(_, id)| id).collect(),
        folders.into_iter().collect(),
    )
}

pub(crate) fn folders(root: &Path) -> Vec<String> {
    walk_notes(root, |_, _| None::<()>).1.into_iter().collect()
}

pub(crate) fn note_paths(root: &Path) -> Vec<(String, PathBuf)> {
    walk_notes(root, |id, entry| Some((id, entry.path()))).0
}

/// Every note id that can collide with `wanted` under `collision_key` — the
/// case- and NFC-folded equality every cross-platform collision check uses.
///
/// A colliding id has the same number of `/` components as `wanted`, and each
/// leading path prefix folds to the same key (`collision_key` never composes
/// or case-folds across a `/`). So only directories whose folded relative path
/// matches the corresponding prefix of `wanted` can hold one, and the walk
/// prunes every other subtree at the directory level. Same traversal rules as
/// [`walk_notes`] (hidden entries skipped, depth-capped, symlinks not followed, the
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
                    && vault_fs::relative_name(root, entry.path()).is_some_and(|relative| {
                        collision_key(&relative) == prefix_keys[depth - 1]
                    });
            }
            depth == note_depth
        });
    for entry in entries.filter_map(Result::ok) {
        if entry.depth() != note_depth || !entry.file_type().is_file() {
            continue;
        }
        if let Some(id) = note_id_of(root, entry.path()) {
            ids.push(id);
        }
    }
    ids
}

/// Every readable note's raw bytes, keyed by id. Raw on purpose: a caller that
/// rewrites a body must decode it losslessly first, and must leave alone a
/// note it cannot (see `prepare_relinks`).
pub(crate) fn bodies(root: &Path) -> HashMap<String, Vec<u8>> {
    note_paths(root)
        .into_iter()
        .filter_map(|(id, _)| {
            let bytes = vault_fs::read(root, &format!("{id}.md")).ok()?;
            Some((id, bytes))
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
    let (preview, rich_preview, tags) = derive(&decode_utf8_lossy(&bytes));
    let (folder, title) = split_id(id);
    Some(NoteMetadata {
        id: id.to_owned(),
        title,
        folder,
        modified_ms: file_mtime_ms(&metadata),
        preview,
        rich_preview,
        tags,
    })
}

fn derive(content: &str) -> (String, String, Vec<String>) {
    (
        make_preview(content),
        make_rich_preview(content),
        note_tags(content),
    )
}

fn decode_utf8_lossy(bytes: &[u8]) -> Cow<'_, str> {
    match simdutf8::basic::from_utf8(bytes) {
        Ok(text) => Cow::Borrowed(text),
        Err(_) => String::from_utf8_lossy(bytes),
    }
}

/// The vault walk: hidden entries skipped, symlinks never followed, notes at
/// most `MAX_FOLDER_DEPTH` folders deep, `.md` files with a safe id only.
/// `on_note` gets each note's id and directory entry, whose `metadata()` is
/// relative to the directory fd on Linux and Android. Sibling folders, and
/// the notes of one folder, are visited in parallel; a folder is closed
/// before its subfolders are opened, so descriptors stay bounded however wide
/// the vault is (iOS apps default to 256).
fn walk_notes<T, F>(root: &Path, on_note: F) -> (Vec<T>, BTreeSet<String>)
where
    T: Send,
    F: Fn(String, &fs::DirEntry) -> Option<T> + Sync,
{
    let (notes, found) = walk_folder(root, "", 0, &on_note);
    let mut folders = BTreeSet::new();
    for folder in found {
        register_ancestors(&folder, &mut folders);
    }
    (notes, folders)
}

/// A visible entry's vault name (`vault_fs::relative_name`) and type. `None`
/// for a name that is not UTF-8, which no vault name can address.
fn visible_entry(entry: &fs::DirEntry, prefix: &str) -> Option<(String, fs::FileType)> {
    let name = entry.file_name();
    let name = name.to_str()?;
    if name.starts_with('.') {
        return None;
    }
    let kind = entry.file_type().ok()?;
    let relative = if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}/{name}")
    };
    Some((relative, kind))
}

fn walk_folder<T, F>(dir: &Path, prefix: &str, depth: usize, on_note: &F) -> (Vec<T>, Vec<String>)
where
    T: Send,
    F: Fn(String, &fs::DirEntry) -> Option<T> + Sync,
{
    let mut folders = Vec::new();
    let mut subfolders = Vec::new();
    let mut notes = Vec::new();
    // A directory listing can repeat a name that a concurrent atomic save
    // replaced mid-read (seen on tmpfs); the note list is a set.
    let (mut seen_folders, mut seen_notes) = (HashSet::new(), HashSet::new());
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let Some((relative, kind)) = visible_entry(&entry, prefix) else {
            continue;
        };
        if kind.is_dir() {
            // A Unix `\` is part of a folder's name, and no folder path can
            // hold one, so that folder is not listed (never `x` and `x/y`),
            // and nothing under it has a note id or a listable path.
            if relative.contains('\\') || !seen_folders.insert(relative.clone()) {
                continue;
            }
            if depth < MAX_FOLDER_DEPTH {
                subfolders.push((entry.path(), relative.clone()));
            }
            folders.push(relative);
        } else if kind.is_file() {
            if let Some(id) = note_id_from_relative_path(&relative) {
                if seen_notes.insert(relative) {
                    notes.push((id, entry));
                }
            }
        }
    }
    let mut found: Vec<T> = notes
        .into_par_iter()
        .filter_map(|(id, entry)| on_note(id, &entry))
        .collect();
    let nested: Vec<(Vec<T>, Vec<String>)> = subfolders
        .into_par_iter()
        .map(|(path, relative)| walk_folder(&path, &relative, depth + 1, on_note))
        .collect();
    for (notes, subfolders) in nested {
        found.extend(notes);
        folders.extend(subfolders);
    }
    (found, folders)
}

/// The note id of a vault file: its vault name (`vault_fs::relative_name`) as
/// a note id, so two files can never share one.
fn note_id_of(root: &Path, path: &Path) -> Option<String> {
    note_id_from_relative_path(&vault_fs::relative_name(root, path)?)
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
