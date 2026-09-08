use std::path::{Path, PathBuf};

use super::relative_components;

fn checked_path(root: &Path, relative: &str, create: bool) -> Result<PathBuf, String> {
    let components = relative_components(relative)?;
    if super::is_link(&std::fs::symlink_metadata(root).map_err(|error| error.to_string())?) {
        return Err("vault root symlink rejected".to_owned());
    }
    let mut path = root.to_owned();
    for component in &components[..components.len() - 1] {
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if super::is_link(&metadata) => {
                return Err(format!("vault parent symlink rejected: {}", path.display()));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "vault parent is not a directory: {}",
                    path.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                std::fs::create_dir(&path).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    path.push(components.last().expect("validated non-empty path"));
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| super::is_link(&metadata)) {
        return Err(format!("vault file symlink rejected: {}", path.display()));
    }
    Ok(path)
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
    crate::files::create_new_atomic(&checked_path(root, relative, true)?, bytes)
}
pub(super) fn move_no_replace(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    crate::files::move_no_replace(
        &checked_path(root, source, false)?,
        &checked_path(root, destination, true)?,
    )
}
pub(super) fn rename_case(root: &Path, source: &str, destination: &str) -> Result<(), String> {
    crate::files::rename_through_temp(
        &checked_path(root, source, false)?,
        &checked_path(root, destination, true)?,
    )
}
pub(super) fn create_dir_all(root: &Path, relative: &str) -> Result<(), String> {
    checked_path(root, &format!("{relative}/.unused"), true).map(|_| ())
}

pub(super) fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    std::fs::read(checked_path(root, relative, false)?).map_err(|error| error.to_string())
}

pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    crate::files::write_atomic_bytes(&checked_path(root, relative, true)?, bytes)
}

pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    match std::fs::remove_file(checked_path(root, relative, false)?) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    let source = checked_path(root, source, false)?;
    let destination = checked_path(root, destination, true)?;
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(checked_path(root, relative, false)?) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn set_mtime_ms(root: &Path, relative: &str, modified_at_ms: i64) -> Result<(), String> {
    crate::files::set_file_mtime_ms(&checked_path(root, relative, false)?, modified_at_ms)
}

pub(super) fn sync_parent(_root: &Path, _relative: &str) -> Result<(), String> {
    Ok(())
}

pub(super) fn write_atomic_local(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    write_atomic(root, relative, bytes)
}
pub(super) fn create_dir(root: &Path, relative: &str) -> Result<(), String> {
    std::fs::create_dir(checked_path(root, relative, false)?).map_err(|e| e.to_string())
}
pub(super) fn remove_dir(root: &Path, relative: &str, recursive: bool) -> Result<(), String> {
    let path = checked_path(root, relative, false)?;
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
