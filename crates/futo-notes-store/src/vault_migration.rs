use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultMigrationStatus {
    Migrated,
    EmptySource,
    AlreadyAtDestination,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultMigrationOutcome {
    pub status: VaultMigrationStatus,
    pub files: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultMigrationFinalization {
    Finalized,
    SourceRetained,
    DestinationChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestEntry {
    is_directory: bool,
    size: u64,
    digest: String,
}

pub(super) fn stage(source: &Path, destination: &Path) -> Result<VaultMigrationOutcome, String> {
    let source = canonical_existing_directory(source, "current notes folder")?;
    let destination = absolute_path(destination)?;
    if source == destination {
        return Ok(VaultMigrationOutcome {
            status: VaultMigrationStatus::AlreadyAtDestination,
            files: 0,
        });
    }
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err(
            "the new notes folder cannot contain or be contained by the current vault".into(),
        );
    }

    let source_manifest = manifest(&source)?;
    let destination_manifest = if destination.exists() {
        if !destination.is_dir() {
            return Err("the new notes folder is not a directory".into());
        }
        Some(manifest(&destination)?)
    } else {
        None
    };
    if source_manifest.is_empty() {
        if destination_manifest
            .as_ref()
            .is_some_and(|manifest| !manifest.is_empty())
        {
            return Err(
                "the new notes folder already contains different files; neither vault was changed"
                    .into(),
            );
        }
        return Ok(VaultMigrationOutcome {
            status: VaultMigrationStatus::EmptySource,
            files: 0,
        });
    }
    if let Some(destination_manifest) = destination_manifest {
        if !destination_manifest.is_empty() {
            if destination_manifest == source_manifest {
                return Ok(VaultMigrationOutcome {
                    status: VaultMigrationStatus::Migrated,
                    files: file_count(&source_manifest),
                });
            }
            return Err(
                "the new notes folder already contains different files; neither vault was changed"
                    .into(),
            );
        }
    }

    let parent = destination
        .parent()
        .ok_or_else(|| "unable to resolve the new notes folder parent".to_owned())?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let staging = create_staging_directory(parent, &destination)?;
    let staged = copy_manifest(&source, &staging, &source_manifest)
        .and_then(|()| manifest(&staging))
        .and_then(|staged_manifest| {
            if staged_manifest == source_manifest {
                Ok(())
            } else {
                Err("the notes copy could not be verified".into())
            }
        });
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "{error}; the original notes folder remains unchanged"
        ));
    }

    if destination.exists() {
        fs::remove_dir(&destination)
            .map_err(|error| format!("unable to prepare the empty destination: {error}"))?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "unable to install the verified notes copy: {error}; the original notes folder remains unchanged"
        ));
    }
    if manifest(&destination)? != source_manifest {
        return Err("the installed notes copy could not be verified".into());
    }

    Ok(VaultMigrationOutcome {
        status: VaultMigrationStatus::Migrated,
        files: file_count(&source_manifest),
    })
}

pub(super) fn finalize(
    source: &Path,
    destination: &Path,
) -> Result<VaultMigrationFinalization, String> {
    if !source.exists() {
        return Ok(VaultMigrationFinalization::Finalized);
    }
    let source = canonical_existing_directory(source, "current notes folder")?;
    let source_manifest = manifest(&source)?;
    if source_manifest.is_empty() && !destination.exists() {
        return Ok(remove_source(&source));
    }
    let destination = match canonical_existing_directory(destination, "new notes folder") {
        Ok(destination) => destination,
        Err(_) => return Ok(VaultMigrationFinalization::DestinationChanged),
    };
    if source == destination {
        return Ok(VaultMigrationFinalization::Finalized);
    }
    if source_manifest != manifest(&destination)? {
        return Ok(VaultMigrationFinalization::DestinationChanged);
    }
    Ok(remove_source(&source))
}

fn remove_source(source: &Path) -> VaultMigrationFinalization {
    match fs::remove_dir_all(source) {
        Ok(()) => VaultMigrationFinalization::Finalized,
        Err(_) => VaultMigrationFinalization::SourceRetained,
    }
}

fn canonical_existing_directory(path: &Path, name: &str) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("unable to read the {name}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("the {name} is not a directory"));
    }
    Ok(canonical)
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(io_error)
    }
}

fn create_staging_directory(parent: &Path, destination: &Path) -> Result<PathBuf, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("vault");
    for _ in 0..100 {
        let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
        let staging = parent.join(format!(
            ".{destination_name}.migration-{}-{suffix}",
            std::process::id()
        ));
        match fs::create_dir(&staging) {
            Ok(()) => return Ok(staging),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(error)),
        }
    }
    Err("unable to allocate a temporary migration folder".into())
}

fn manifest(root: &Path) -> Result<BTreeMap<PathBuf, ManifestEntry>, String> {
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

fn copy_manifest(
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
    output.sync_all().map_err(io_error)
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

fn file_count(manifest: &BTreeMap<PathBuf, ManifestEntry>) -> u32 {
    manifest
        .values()
        .filter(|entry| !entry.is_directory)
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}
