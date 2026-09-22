use std::path::{Path, PathBuf};

use super::{context, relative_components, OpenParentError};

/// A parent directory must be a real directory, not a link and not a file.
fn accept_parent(path: &Path, metadata: &std::fs::Metadata) -> Result<(), OpenParentError> {
    if super::is_link(metadata) {
        return Err(OpenParentError::Other(format!(
            "vault parent symlink rejected: {}",
            path.display()
        )));
    }
    if !metadata.is_dir() {
        return Err(OpenParentError::Other(format!(
            "vault parent is not a directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn checked_path(root: &Path, relative: &str, create: bool) -> Result<PathBuf, OpenParentError> {
    let components = relative_components(relative).map_err(OpenParentError::Other)?;
    let root_metadata = std::fs::symlink_metadata(root).map_err(|error| {
        let message = context("open vault root for", relative, &error);
        if error.kind() == std::io::ErrorKind::NotFound {
            OpenParentError::NotFound(message)
        } else {
            OpenParentError::Other(message)
        }
    })?;
    if super::is_link(&root_metadata) {
        return Err(OpenParentError::Other(
            "vault root symlink rejected".to_owned(),
        ));
    }
    let mut path = root.to_owned();
    for component in &components[..components.len() - 1] {
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => accept_parent(&path, &metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                match std::fs::create_dir(&path) {
                    Ok(()) => {}
                    // A peer writer creating the same folder inside this window
                    // is a race, not a failure — `mkdirat` EEXIST is tolerated
                    // the same way on Unix. Re-stat rather than assume: Unix
                    // reopens with O_DIRECTORY here and fails ENOTDIR if what
                    // landed is not a directory.
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                            OpenParentError::Other(context(
                                "open created parent for",
                                relative,
                                error,
                            ))
                        })?;
                        accept_parent(&path, &metadata)?;
                    }
                    Err(error) => {
                        return Err(OpenParentError::Other(context(
                            "create parent for",
                            relative,
                            error,
                        )))
                    }
                }
            }
            // The leaf cannot exist when the folder holding it does not. Say
            // ABSENT and let the caller decide: `exists`/`remove`/`rename`
            // answer no, the write paths above pass `create` and make the
            // folder. Reporting a fault here instead is github#48 — the sync
            // engine recorded a permanent per-note failure and pinned its pull
            // cursor for every note in a folder this client did not have yet.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(OpenParentError::NotFound(context(
                    "open parent for",
                    relative,
                    error,
                )))
            }
            Err(error) => {
                return Err(OpenParentError::Other(context(
                    "open parent for",
                    relative,
                    error,
                )))
            }
        }
    }
    path.push(components.last().expect("validated non-empty path"));
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| super::is_link(&metadata)) {
        return Err(OpenParentError::Other(format!(
            "vault file symlink rejected: {}",
            path.display()
        )));
    }
    Ok(path)
}

/// Resolve for an operation whose answer for a missing parent folder is
/// "nothing there": `Ok(None)`. A real fault still propagates.
fn resolve_or_absent(root: &Path, relative: &str, create: bool) -> Result<Option<PathBuf>, String> {
    match checked_path(root, relative, create) {
        Ok(path) => Ok(Some(path)),
        Err(OpenParentError::NotFound(_)) => Ok(None),
        Err(error) => Err(error.message()),
    }
}

pub(super) fn read_optional(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    super::validate_path(root, relative)?;
    match std::fs::read(root.join(relative)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
pub(super) fn create_new(root: &Path, relative: &str, bytes: &[u8]) -> Result<bool, String> {
    crate::files::create_new_atomic(
        &checked_path(root, relative, true).map_err(OpenParentError::message)?,
        bytes,
    )
}
pub(super) fn move_no_replace(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    crate::files::move_no_replace(
        &checked_path(root, source, false).map_err(OpenParentError::message)?,
        &checked_path(root, destination, true).map_err(OpenParentError::message)?,
    )
}
pub(super) fn rename_case(root: &Path, source: &str, destination: &str) -> Result<(), String> {
    crate::files::rename_through_temp(
        &checked_path(root, source, false).map_err(OpenParentError::message)?,
        &checked_path(root, destination, true).map_err(OpenParentError::message)?,
    )
}
pub(super) fn create_dir_all(root: &Path, relative: &str) -> Result<(), String> {
    checked_path(root, &format!("{relative}/.unused"), true)
        .map(|_| ())
        .map_err(OpenParentError::message)
}

pub(super) fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = checked_path(root, relative, false).map_err(OpenParentError::message)?;
    std::fs::read(path).map_err(|error| context("read", relative, error))
}

pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let path = checked_path(root, relative, true).map_err(OpenParentError::message)?;
    crate::files::write_atomic_bytes(&path, bytes)
}

pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    let Some(path) = resolve_or_absent(root, relative, false)? else {
        return Ok(false);
    };
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(context("remove", relative, error)),
    }
}

pub(super) fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    // Only the SOURCE side reports absence; the destination is being created,
    // so a missing folder there is made rather than reported.
    let Some(source_path) = resolve_or_absent(root, source, false)? else {
        return Ok(false);
    };
    let destination_path =
        checked_path(root, destination, true).map_err(OpenParentError::message)?;
    match std::fs::rename(source_path, destination_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(context("rename", source, error)),
    }
}

pub(super) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    let Some(path) = resolve_or_absent(root, relative, false)? else {
        return Ok(false);
    };
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(context("inspect", relative, error)),
    }
}

pub(super) fn set_mtime_ms(root: &Path, relative: &str, modified_at_ms: i64) -> Result<(), String> {
    let path = checked_path(root, relative, false).map_err(OpenParentError::message)?;
    crate::files::set_file_mtime_ms(&path, modified_at_ms)
}

pub(super) fn sync_parent(_root: &Path, _relative: &str) -> Result<(), String> {
    Ok(())
}

pub(super) fn write_atomic_local(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    write_atomic(root, relative, bytes)
}
pub(super) fn create_dir(root: &Path, relative: &str) -> Result<(), String> {
    let path = checked_path(root, relative, false).map_err(OpenParentError::message)?;
    std::fs::create_dir(path).map_err(|error| context("create directory", relative, error))
}
pub(super) fn remove_dir(root: &Path, relative: &str, recursive: bool) -> Result<(), String> {
    let path = checked_path(root, relative, false).map_err(OpenParentError::message)?;
    if recursive {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_dir(path)
    }
    .map_err(|e| e.to_string())
}
pub(super) fn clear(root: &Path) -> Result<(), String> {
    if super::is_link(&std::fs::symlink_metadata(root).map_err(|e| e.to_string())?) {
        return Err("vault root symlink rejected".into());
    }
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            std::fs::remove_dir_all(entry.path())
        } else {
            std::fs::remove_file(entry.path())
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn remove_local(root: &Path, relative: &str) -> Result<bool, String> {
    remove(root, relative)
}
pub(super) fn rename_local(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    rename(root, source, destination)
}
