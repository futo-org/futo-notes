use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(test)]
use std::cell::RefCell;

mod durability;
mod manifest;

use durability::{
    make_existing_destination_durable, nearest_existing_directory, sync_directory_chain,
    sync_manifest_directories,
};
use manifest::{copy_manifest, file_count, manifest};

#[cfg(test)]
thread_local! {
    static DIRECTORY_SYNC_HOOK: RefCell<Option<Box<dyn FnMut(&Path) -> Result<(), String>>>> =
        RefCell::new(None);
}

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

/// What a candidate notes folder already holds, so the shell can choose between
/// migrating into it and opening it as-is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultDestinationState {
    /// Absent, or present with no entries — [`stage`] will accept a copy.
    Empty,
    /// Holds entries already. Copying into it is refused, so it is opened instead.
    Occupied,
    /// Cannot host a vault: not a directory, unreadable, or nested with the
    /// current root.
    Unusable,
}

/// [`VaultDestinationState`] plus what a user needs to tell two folders apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultDestinationInspection {
    pub state: VaultDestinationState,
    /// Notes the folder holds — 0 for [`VaultDestinationState::Empty`], and for
    /// an occupied folder that holds only non-note files.
    pub notes: u32,
    /// Newest note mtime in milliseconds since the epoch, 0 when there is none.
    pub last_modified_ms: u64,
}

pub(super) fn inspect(source: &Path, destination: &Path) -> VaultDestinationInspection {
    let unusable = VaultDestinationInspection {
        state: VaultDestinationState::Unusable,
        notes: 0,
        last_modified_ms: 0,
    };
    let Ok(destination) = canonical_absolute(destination) else {
        return unusable;
    };
    // Canonicalizing the source only matters for the containment check, and an
    // absent source cannot contain anything.
    if let Ok(source) = fs::canonicalize(source) {
        if destination.starts_with(&source) || source.starts_with(&destination) {
            return unusable;
        }
    }
    match fs::metadata(&destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return VaultDestinationInspection {
                state: VaultDestinationState::Empty,
                notes: 0,
                last_modified_ms: 0,
            };
        }
        Err(_) => return unusable,
        Ok(metadata) if !metadata.is_dir() => return unusable,
        Ok(_) => {}
    }
    let Ok(mut entries) = fs::read_dir(&destination) else {
        return unusable;
    };
    if entries.next().is_none() {
        return VaultDestinationInspection {
            state: VaultDestinationState::Empty,
            notes: 0,
            last_modified_ms: 0,
        };
    }
    let notes = crate::vault::note_paths(&destination);
    VaultDestinationInspection {
        state: VaultDestinationState::Occupied,
        notes: notes.len().try_into().unwrap_or(u32::MAX),
        last_modified_ms: notes
            .iter()
            .filter_map(|(_, path)| newest_modified_ms(path))
            .max()
            .unwrap_or(0),
    }
}

fn newest_modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis().try_into().unwrap_or(u64::MAX))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestEntry {
    is_directory: bool,
    size: u64,
    digest: String,
}

pub(super) fn stage(source: &Path, destination: &Path) -> Result<VaultMigrationOutcome, String> {
    let source = canonical_existing_directory(source, "current notes folder")?;
    let destination = canonical_absolute(destination)?;
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
                make_existing_destination_durable(&destination, &source_manifest).map_err(
                    |error| {
                        format!(
                            "unable to make the verified notes copy durable: {error}; the original notes folder remains unchanged"
                        )
                    },
                )?;
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
    let existing_parent_ancestor = nearest_existing_directory(parent)?;
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
        })
        .and_then(|()| sync_manifest_directories(&staging, &source_manifest));
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
    if let Err(error) = sync_directory_chain(parent, &existing_parent_ancestor) {
        return Err(format!(
            "unable to make the verified notes copy durable: {error}; the original notes folder remains unchanged"
        ));
    }

    Ok(VaultMigrationOutcome {
        status: VaultMigrationStatus::Migrated,
        files: file_count(&source_manifest),
    })
}

pub(super) fn finalize(
    source: &Path,
    destination: &Path,
    allow_source_removal: bool,
) -> Result<VaultMigrationFinalization, String> {
    match source.try_exists() {
        Ok(false) => return Ok(VaultMigrationFinalization::Finalized),
        Ok(true) => {}
        Err(error) => {
            return Err(format!(
                "unable to inspect the current notes folder: {error}"
            ));
        }
    }
    let source = canonical_existing_directory(source, "current notes folder")?;
    let source_manifest = manifest(&source)?;
    if source_manifest.is_empty() && !destination.exists() {
        return Ok(if allow_source_removal {
            remove_source(&source)
        } else {
            VaultMigrationFinalization::SourceRetained
        });
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
    Ok(if allow_source_removal {
        remove_source(&source)
    } else {
        VaultMigrationFinalization::SourceRetained
    })
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

/// Absolute path with every ancestor that exists resolved through symlinks.
///
/// The containment checks compare a destination against a canonicalized source,
/// so both sides have to be canonical or the comparison is meaningless.
/// `fs::canonicalize` can't be used on its own: a migration destination usually
/// does not exist yet, and it errors on a missing path. So canonicalize the
/// longest existing prefix and re-append the rest.
///
/// This is not cosmetic. On macOS `std::env::temp_dir()` hands out
/// `/var/folders/…`, a symlink to `/private/var/folders/…`. An absolutized-only
/// destination therefore shared no prefix with its canonicalized source, and
/// `inspect` reported a destination NESTED INSIDE the current vault as `Empty`
/// — clearing it to be copied into — instead of `Unusable`. Caught by
/// `inspect_rejects_a_file_or_a_destination_nested_with_the_source` on the
/// macOS CI runner only, since Linux `/tmp` is a real directory.
fn canonical_absolute(path: &Path) -> Result<PathBuf, String> {
    let absolute = absolute_path(path)?;
    let mut unresolved_suffix = Vec::new();
    let mut candidate = absolute.as_path();
    loop {
        if let Ok(mut resolved) = fs::canonicalize(candidate) {
            resolved.extend(unresolved_suffix.iter().rev());
            return Ok(resolved);
        }
        // Nothing on this path exists (or it is unreadable); the absolutized form
        // is the best answer available, and it is what the old code always used.
        let (Some(name), Some(parent)) = (candidate.file_name(), candidate.parent()) else {
            return Ok(absolute);
        };
        unresolved_suffix.push(name.to_owned());
        candidate = parent;
    }
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

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests;
