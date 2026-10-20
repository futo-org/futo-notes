//! Making a staged or finalized vault durable: directory fsync chains.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(test)]
use super::DIRECTORY_SYNC_HOOK;
use super::{io_error, ManifestEntry};

pub(super) fn make_existing_destination_durable(
    destination: &Path,
    manifest: &BTreeMap<PathBuf, ManifestEntry>,
) -> Result<(), String> {
    for (relative, entry) in manifest {
        if !entry.is_directory {
            fs::File::open(destination.join(relative))
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
        }
    }
    sync_manifest_directories(destination, manifest)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "unable to resolve the new notes folder parent".to_owned())?;
    sync_directory_ancestors(parent)
}

pub(super) fn sync_manifest_directories(
    root: &Path,
    manifest: &BTreeMap<PathBuf, ManifestEntry>,
) -> Result<(), String> {
    let mut directories = manifest
        .iter()
        .filter(|(_, entry)| entry.is_directory)
        .map(|(relative, _)| root.join(relative))
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| {
        right
            .components()
            .count()
            .cmp(&left.components().count())
            .then_with(|| left.cmp(right))
    });
    for directory in directories {
        sync_directory(&directory)?;
    }
    sync_directory(root)
}

pub(super) fn nearest_existing_directory(path: &Path) -> Result<PathBuf, String> {
    let mut candidate = path;
    loop {
        match fs::metadata(candidate) {
            Ok(metadata) if metadata.is_dir() => return Ok(candidate.to_path_buf()),
            Ok(_) => {
                return Err(format!(
                    "the new notes folder parent is not a directory: {}",
                    candidate.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate
                    .parent()
                    .ok_or_else(|| "unable to resolve an existing destination parent".to_owned())?;
            }
            Err(error) => return Err(io_error(error)),
        }
    }
}

pub(super) fn sync_directory_chain(path: &Path, inclusive_ancestor: &Path) -> Result<(), String> {
    let mut directory = path;
    loop {
        sync_directory(directory)?;
        if directory == inclusive_ancestor {
            return Ok(());
        }
        directory = directory.parent().ok_or_else(|| {
            "the destination parent escaped its existing ancestor during installation".to_owned()
        })?;
    }
}

fn sync_directory_ancestors(path: &Path) -> Result<(), String> {
    let mut directory = Some(path);
    while let Some(current) = directory {
        sync_directory(current)?;
        directory = current.parent();
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    if DIRECTORY_SYNC_HOOK.with(|hook| hook.borrow().is_some()) {
        return DIRECTORY_SYNC_HOOK.with(|hook| {
            hook.borrow_mut()
                .as_mut()
                .expect("directory sync hook disappeared")(path)
        });
    }

    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}
