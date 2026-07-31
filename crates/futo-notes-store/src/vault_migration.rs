use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(test)]
use std::cell::RefCell;

use sha2::{Digest, Sha256};

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

fn make_existing_destination_durable(
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

fn sync_manifest_directories(
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

fn nearest_existing_directory(path: &Path) -> Result<PathBuf, String> {
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

fn sync_directory_chain(path: &Path, inclusive_ancestor: &Path) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "futo-notes-vault-migration-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            // Canonical, because `stage`/`inspect` canonicalize what they are
            // handed and the sync-ordering tests below compare observed paths
            // against ones built from this root. On macOS `temp_dir()` is
            // `/var/folders/…`, a symlink to `/private/var/folders/…`, so an
            // un-canonicalized root makes every such comparison fail there while
            // passing on Linux. Reproduce that locally with
            // `TMPDIR=<a symlink to a real dir> cargo test -p futo-notes-store`.
            Self(fs::canonicalize(&path).unwrap_or(path))
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct DirectorySyncHookGuard;

    impl Drop for DirectorySyncHookGuard {
        fn drop(&mut self) {
            DIRECTORY_SYNC_HOOK.with(|hook| {
                hook.borrow_mut().take();
            });
        }
    }

    fn with_directory_sync_hook<T>(
        hook: impl FnMut(&Path) -> Result<(), String> + 'static,
        action: impl FnOnce() -> T,
    ) -> T {
        DIRECTORY_SYNC_HOOK.with(|slot| {
            assert!(slot.borrow().is_none(), "directory sync hook already set");
            *slot.borrow_mut() = Some(Box::new(hook));
        });
        let _guard = DirectorySyncHookGuard;
        action()
    }

    #[test]
    fn stage_syncs_copied_directories_before_installing_destination() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let destination = root.0.join("destination");
        fs::create_dir_all(source.join("Nested/Deep")).unwrap();
        fs::write(source.join("Nested/Deep/note.md"), "body").unwrap();
        let synced = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&synced);

        let outcome = with_directory_sync_hook(
            move |path| {
                observed.lock().unwrap().push(path.to_path_buf());
                Ok(())
            },
            || stage(&source, &destination),
        )
        .unwrap();

        assert_eq!(outcome.status, VaultMigrationStatus::Migrated);
        let synced = synced.lock().unwrap();
        let deep = synced
            .iter()
            .position(|path| path.ends_with("Nested/Deep"))
            .expect("deep staged directory was not synced");
        let nested = synced
            .iter()
            .position(|path| path.ends_with("Nested"))
            .expect("nested staged directory was not synced");
        let staging = synced
            .iter()
            .position(|path| {
                path.parent() == Some(root.0.as_path())
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(".destination.migration-"))
            })
            .expect("staging root was not synced");
        let destination_parent = synced
            .iter()
            .rposition(|path| path == &root.0)
            .expect("destination parent was not synced");
        assert!(deep < nested);
        assert!(nested < staging);
        assert!(staging < destination_parent);
    }

    #[test]
    fn stage_does_not_install_when_staged_directory_sync_fails() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let destination = root.0.join("destination");
        fs::create_dir_all(source.join("Nested")).unwrap();
        fs::write(source.join("Nested/note.md"), "body").unwrap();

        let result = with_directory_sync_hook(
            |_| Err("injected directory sync failure".into()),
            || stage(&source, &destination),
        );

        assert_eq!(
            result.unwrap_err(),
            "injected directory sync failure; the original notes folder remains unchanged"
        );
        assert!(source.join("Nested/note.md").exists());
        assert!(!destination.exists());
    }

    #[test]
    fn stage_syncs_new_destination_parent_entries_through_the_existing_ancestor() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let new_parent = root.0.join("New/Deep");
        let destination = new_parent.join("destination");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("note.md"), "body").unwrap();
        let synced = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&synced);

        with_directory_sync_hook(
            move |path| {
                observed.lock().unwrap().push(path.to_path_buf());
                Ok(())
            },
            || stage(&source, &destination),
        )
        .unwrap();

        let synced = synced.lock().unwrap();
        let deep = synced
            .iter()
            .rposition(|path| path == &new_parent)
            .expect("destination parent was not synced");
        let new = synced
            .iter()
            .rposition(|path| path == &root.0.join("New"))
            .expect("new parent entry was not synced");
        let existing = synced
            .iter()
            .rposition(|path| path == &root.0)
            .expect("existing ancestor was not synced");
        assert!(deep < new);
        assert!(new < existing);
    }

    #[test]
    fn stage_retries_durability_for_an_already_installed_matching_destination() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let new_parent = root.0.join("New/Deep");
        let destination = new_parent.join("destination");
        fs::create_dir_all(source.join("Nested")).unwrap();
        fs::write(source.join("Nested/note.md"), "body").unwrap();
        let failed_parent = root.0.join("New");

        let first_result = with_directory_sync_hook(
            move |path| {
                if path == failed_parent {
                    Err("injected destination-parent sync failure".into())
                } else {
                    Ok(())
                }
            },
            || stage(&source, &destination),
        );
        assert!(first_result.is_err());
        assert!(destination.join("Nested/note.md").exists());

        let synced = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&synced);
        let retry = with_directory_sync_hook(
            move |path| {
                observed.lock().unwrap().push(path.to_path_buf());
                Ok(())
            },
            || stage(&source, &destination),
        )
        .unwrap();

        assert_eq!(retry.status, VaultMigrationStatus::Migrated);
        let synced = synced.lock().unwrap();
        assert!(
            synced
                .iter()
                .any(|path| path == &destination.join("Nested")),
            "matching destination directory was not re-synced"
        );
        assert!(
            synced.iter().any(|path| path == &destination),
            "matching destination root was not re-synced"
        );
        assert!(
            synced.iter().any(|path| path == &new_parent),
            "matching destination immediate parent was not re-synced"
        );
        assert!(
            synced.iter().any(|path| path == &root.0.join("New")),
            "matching destination ancestor was not re-synced"
        );
        assert!(
            synced.iter().any(|path| path == &root.0),
            "matching destination existing ancestor was not re-synced"
        );
    }

    // ── destination inspection: migrate into empty, open occupied ──

    #[test]
    fn inspect_reports_an_absent_or_entryless_destination_as_empty() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        fs::create_dir_all(&source).unwrap();

        let absent = inspect(&source, &root.0.join("absent"));
        assert_eq!(absent.state, VaultDestinationState::Empty);
        assert_eq!(absent.notes, 0);

        let entryless = root.0.join("entryless");
        fs::create_dir_all(&entryless).unwrap();
        assert_eq!(
            inspect(&source, &entryless).state,
            VaultDestinationState::Empty
        );
    }

    #[test]
    fn inspect_counts_the_notes_an_occupied_destination_already_holds() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let destination = root.0.join("destination");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(destination.join("Folder")).unwrap();
        fs::write(destination.join("Kept.md"), "body").unwrap();
        fs::write(destination.join("Folder/Nested.md"), "body").unwrap();

        let inspection = inspect(&source, &destination);

        assert_eq!(inspection.state, VaultDestinationState::Occupied);
        assert_eq!(inspection.notes, 2);
        assert!(
            inspection.last_modified_ms > 0,
            "an occupied destination should report when its notes last changed"
        );
    }

    /// A folder holding only non-note files is still occupied — `stage` refuses
    /// any non-empty destination — so it is opened, and honestly reports 0 notes.
    #[test]
    fn inspect_reports_a_destination_holding_no_notes_as_occupied_with_no_notes() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let destination = root.0.join("destination");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join(".txt-migration-done"), "1").unwrap();

        let inspection = inspect(&source, &destination);

        assert_eq!(inspection.state, VaultDestinationState::Occupied);
        assert_eq!(inspection.notes, 0);
    }

    #[test]
    fn inspect_rejects_a_file_or_a_destination_nested_with_the_source() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        fs::create_dir_all(&source).unwrap();
        let file = root.0.join("not-a-directory");
        fs::write(&file, "body").unwrap();

        assert_eq!(
            inspect(&source, &file).state,
            VaultDestinationState::Unusable
        );
        assert_eq!(
            inspect(&source, &source.join("inside")).state,
            VaultDestinationState::Unusable
        );
        assert_eq!(
            inspect(&source, source.parent().unwrap()).state,
            VaultDestinationState::Unusable
        );
    }

    /// Reproduces on Linux what only macOS CI hit: the same folder reached
    /// through a symlinked ancestor. macOS `temp_dir()` is `/var/folders/…`, a
    /// symlink to `/private/var/folders/…`, so the canonicalized source and the
    /// absolutized-only destination shared no prefix and a nested destination
    /// read as `Empty`. An explicit symlink makes the failure host-independent.
    #[cfg(unix)]
    #[test]
    fn inspect_rejects_a_nested_destination_reached_through_a_symlinked_ancestor() {
        let root = TestDirectory::new();
        let real = root.0.join("real");
        let source = real.join("source");
        fs::create_dir_all(&source).unwrap();
        std::os::unix::fs::symlink(&real, root.0.join("link")).unwrap();

        let nested_via_symlink = root.0.join("link/source/inside");

        assert_eq!(
            inspect(&source, &nested_via_symlink).state,
            VaultDestinationState::Unusable,
            "a destination inside the current vault must be refused however its path spells it"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stage_refuses_a_nested_destination_reached_through_a_symlinked_ancestor() {
        let root = TestDirectory::new();
        let real = root.0.join("real");
        let source = real.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("note.md"), "body").unwrap();
        std::os::unix::fs::symlink(&real, root.0.join("link")).unwrap();

        let result = stage(&source, &root.0.join("link/source/inside"));

        assert_eq!(
            result.unwrap_err(),
            "the new notes folder cannot contain or be contained by the current vault"
        );
        assert!(source.join("note.md").exists());
        assert!(!source.join("inside").exists());
    }

    #[test]
    fn finalize_rechecks_a_retained_source_before_activation() {
        let root = TestDirectory::new();
        let source = root.0.join("source");
        let destination = root.0.join("destination");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("note.md"), "staged body").unwrap();

        stage(&source, &destination).unwrap();
        fs::write(source.join("note.md"), "late external edit").unwrap();

        assert_eq!(
            finalize(&source, &destination, false).unwrap(),
            VaultMigrationFinalization::DestinationChanged
        );
        assert!(source.exists());
        assert!(destination.exists());
    }
}
