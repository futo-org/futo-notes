//! The staged copy: the source manifest, verified file copies, and content hashes.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{io_error, ManifestEntry};

pub(super) fn manifest(root: &Path) -> Result<BTreeMap<PathBuf, ManifestEntry>, String> {
    fn walk(
        root: &Path,
        directory: &Path,
        entries: &mut BTreeMap<PathBuf, ManifestEntry>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(io_error)?;
            if file_type.is_symlink() {
                return Err(format!(
                    "vault migration does not follow symbolic links: {}",
                    path.display()
                ));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|error| format!("vault entry escaped the root: {error}"))?
                .to_path_buf();
            if file_type.is_dir() {
                entries.insert(
                    relative,
                    ManifestEntry {
                        is_directory: true,
                        size: 0,
                        digest: String::new(),
                    },
                );
                walk(root, &path, entries)?;
            } else if file_type.is_file() {
                let metadata = entry.metadata().map_err(io_error)?;
                entries.insert(
                    relative,
                    ManifestEntry {
                        is_directory: false,
                        size: metadata.len(),
                        digest: sha256(&path)?,
                    },
                );
            } else {
                return Err(format!(
                    "unsupported vault entry during migration: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let mut entries = BTreeMap::new();
    walk(root, root, &mut entries)?;
    Ok(entries)
}

pub(super) fn copy_manifest(
    source: &Path,
    staging: &Path,
    manifest: &BTreeMap<PathBuf, ManifestEntry>,
) -> Result<(), String> {
    for (relative, entry) in manifest {
        let source_path = source.join(relative);
        let destination_path = staging.join(relative);
        if entry.is_directory {
            fs::create_dir_all(&destination_path).map_err(io_error)?;
            continue;
        }
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        copy_file(&source_path, &destination_path)?;
    }
    Ok(())
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = fs::File::open(source).map_err(io_error)?;
    let modified = input
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok();
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(io_error)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).map_err(io_error)?;
    }
    if let Some(modified) = modified {
        let _ = output.set_modified(modified);
    }
    output.sync_all().map_err(io_error)?;
    Ok(())
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn file_count(manifest: &BTreeMap<PathBuf, ManifestEntry>) -> u32 {
    manifest
        .values()
        .filter(|entry| !entry.is_directory)
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}
