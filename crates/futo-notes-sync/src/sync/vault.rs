use std::collections::HashSet;
use std::path::Path;

use futo_notes_core::e2ee::{collision_conflict_filename, conflict_filename};
use futo_notes_core::files::{
    file_mtime_ms, read_blob_as_base64, write_atomic_text, write_base64_as_blob,
};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::{is_image_filename, is_syncable_filename};

use super::PreWrite;

#[derive(Clone)]
pub(super) struct LocalFile {
    pub(super) name: String,
    pub(super) mtime: i64,
    pub(super) size: u64,
}

pub(super) fn local_files(root: &Path) -> Vec<LocalFile> {
    fn walk(root: &Path, dir: &Path, files: &mut Vec<LocalFile>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, files);
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let name = relative.to_string_lossy().replace('\\', "/");
            if !is_syncable_filename(&name) {
                continue;
            }
            if let Ok(metadata) = entry.metadata() {
                files.push(LocalFile {
                    name,
                    mtime: file_mtime_ms(&metadata),
                    size: metadata.len(),
                });
            }
        }
    }
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort_by(|left, right| left.name.cmp(&right.name));
    files
}

pub(super) fn read_content(root: &Path, name: &str) -> Result<String, String> {
    let path = root.join(name);
    if is_image_filename(name) {
        read_blob_as_base64(&path)
    } else {
        std::fs::read_to_string(path).map_err(|error| error.to_string())
    }
}

pub(super) fn write_content(
    root: &Path,
    name: &str,
    content: &str,
    pre_write: &PreWrite,
) -> Result<(), String> {
    pre_write(name);
    let path = root.join(name);
    if is_image_filename(name) {
        write_base64_as_blob(&path, content)
    } else {
        write_atomic_text(&path, content)
    }
}

pub(super) fn remove_local(root: &Path, name: &str, pre_write: &PreWrite) -> Result<bool, String> {
    pre_write(name);
    match std::fs::remove_file(root.join(name)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn conflict_date() -> String {
    let date = time::OffsetDateTime::now_utc().date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

pub(super) fn park_local(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<String, String> {
    let mut target = collision_conflict_filename(name, object_id);
    if root.join(&target).exists() {
        let names: HashSet<_> = local_files(root)
            .into_iter()
            .map(|file| file.name)
            .collect();
        target = conflict_filename(name, &conflict_date(), &names);
    }
    pre_write(name);
    pre_write(&target);
    if let Some(parent) = root.join(&target).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(root.join(name), root.join(&target)).map_err(|error| error.to_string())?;
    Ok(target)
}

pub(super) fn content_hash(root: &Path, name: &str) -> Option<String> {
    read_content(root, name)
        .ok()
        .map(|content| hash_sha256(&content))
}
