use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use super::filenames::collision_key;
use super::paths::MAX_FOLDER_DEPTH;
use super::timestamps::{file_mtime_ms, now_ms};
use super::vault_fs;

const BACKUP_PREFIX: &str = ".sf-bak-";
const BACKUP_SIDECAR_SUFFIX: &str = ".path";
/// The name every atomic write's temp file carries until it is installed.
pub(super) const TEMP_PURPOSE: &str = "tmp";
/// A case-only rename's stop on the way to its destination. Named apart from the
/// write temp on purpose: while a hop exists it holds the ONLY copy of a note, so
/// the stale-temp sweep must never mistake it for litter.
pub(super) const HOP_PURPOSE: &str = "hop";
/// A save's temp lives from its create to its rename, milliseconds. One this old
/// is a crash's leftover, so the margin is only about a stalled disk; a late
/// sweep costs a hidden file for one more launch, an early one costs a save.
const TEMP_PREFIX: &str = ".sf-tmp-";
const STALE_TEMP_AGE_MS: i64 = 10 * 60 * 1000;

static HIDDEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn hidden_path(parent: &Path, purpose: &str) -> PathBuf {
    let sequence = HIDDEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".sf-{purpose}-{}-{}-{sequence}",
        std::process::id(),
        now_ms()
    ))
}

fn matching_destination_files(parent: &Path, destination: &Path) -> Vec<PathBuf> {
    let Some(target) = destination.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let key = collision_key(target);
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let path = entry.path();
            (path.is_file() && collision_key(name) == key).then_some(path)
        })
        .collect()
}

fn sidecar_of(backup: &Path) -> PathBuf {
    let mut name = backup.as_os_str().to_owned();
    name.push(BACKUP_SIDECAR_SUFFIX);
    PathBuf::from(name)
}

fn park_destinations(parent: &Path, destination: &Path) -> Vec<(PathBuf, PathBuf)> {
    matching_destination_files(parent, destination)
        .into_iter()
        .filter_map(|original| {
            let backup = hidden_path(parent, "bak");
            let leaf = original.file_name()?.to_str()?.to_owned();
            // Persist the original name first so a crash after the park remains recoverable.
            if fs::write(sidecar_of(&backup), leaf.as_bytes()).is_err() {
                return None;
            }
            match fs::rename(&original, &backup) {
                Ok(()) => Some((original, backup)),
                Err(_) => {
                    let _ = fs::remove_file(sidecar_of(&backup));
                    None
                }
            }
        })
        .collect()
}

#[derive(Debug)]
pub struct RecoveredBackup {
    pub leaf: String,
    pub backup: PathBuf,
    pub sidecar: PathBuf,
}

/// Returns divergent backups intact so callers can rename them visibly before removing the sidecar.
#[must_use]
pub fn recover_parked_backups(root: &Path) -> Vec<RecoveredBackup> {
    let Ok(_guard) = super::vault_mutation_guard() else {
        return Vec::new();
    };
    recover_parked_backups_locked(root).0
}

/// Caller holds the vault guard once across this parallel scan and all follow-up
/// installs. Workers never reacquire it; failed restores retain backup + sidecar.
#[must_use]
pub fn recover_parked_backups_locked(root: &Path) -> (Vec<RecoveredBackup>, Vec<String>) {
    recover_parked_in(root, root, 0)
}

/// Sibling directories are scanned in parallel: this runs before every vault
/// open. `scan_parked_entries` has closed each directory before recursing.
fn recover_parked_in(root: &Path, dir: &Path, depth: usize) -> (Vec<RecoveredBackup>, Vec<String>) {
    let Some(entries) = scan_parked_entries(dir) else {
        return (Vec::new(), Vec::new());
    };

    let mut recovered = Vec::new();
    let mut warnings = Vec::new();
    for name in &entries.backups {
        match recover_parked_backup(root, dir, name) {
            Ok(Some(backup)) => recovered.push(backup),
            Ok(None) => {}
            Err(error) => warnings.push(format!("recovered backup {name}: {error}")),
        }
    }
    remove_orphan_sidecars(dir, entries.sidecars);
    sweep_stale_temps(dir, entries.temps);

    if depth < MAX_FOLDER_DEPTH {
        let nested: Vec<_> = entries
            .subdirs
            .par_iter()
            .map(|subdir| recover_parked_in(root, subdir, depth + 1))
            .collect();
        for (backups, errors) in nested {
            recovered.extend(backups);
            warnings.extend(errors);
        }
    }
    (recovered, warnings)
}

struct ParkedEntries {
    subdirs: Vec<PathBuf>,
    backups: Vec<String>,
    sidecars: Vec<String>,
    temps: Vec<String>,
}

fn scan_parked_entries(dir: &Path) -> Option<ParkedEntries> {
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    let mut backups = Vec::new();
    let mut sidecars = Vec::new();
    let mut temps = Vec::new();
    for entry in entries.flatten() {
        // Do not follow directory symlinks; a vault-local loop would overflow bootstrap recovery.
        let real_dir = entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        if real_dir {
            subdirs.push(entry.path());
        } else if let Some(name) = entry.file_name().to_str() {
            if name.starts_with(BACKUP_PREFIX) {
                if name.ends_with(BACKUP_SIDECAR_SUFFIX) {
                    sidecars.push(name.to_owned());
                } else {
                    backups.push(name.to_owned());
                }
            } else if name.starts_with(TEMP_PREFIX) {
                temps.push(name.to_owned());
            }
        }
    }
    Some(ParkedEntries {
        subdirs,
        backups,
        sidecars,
        temps,
    })
}

fn recover_parked_backup(
    root: &Path,
    dir: &Path,
    name: &str,
) -> Result<Option<RecoveredBackup>, String> {
    let backup = dir.join(name);
    let sidecar = dir.join(format!("{name}{BACKUP_SIDECAR_SUFFIX}"));
    let Ok(leaf) = fs::read_to_string(&sidecar) else {
        return Ok(None);
    };
    let leaf = leaf.trim();
    if leaf.is_empty() || leaf.contains('/') || leaf.contains('\\') {
        return Ok(None);
    }
    let destination = dir.join(leaf);
    // A no-replace move installs the backup at its canonical name without a
    // check-then-write race and consumes the backup on success.
    let source = vault_fs::relative_name(root, &backup).ok_or("invalid backup path")?;
    let target = vault_fs::relative_name(root, &destination).ok_or("invalid backup destination")?;
    match vault_fs::move_no_replace(root, &source, &target) {
        Ok(true) => {
            let _ = fs::remove_file(&sidecar);
            Ok(None)
        }
        Ok(false) => match (fs::read(&backup), fs::read(&destination)) {
            (Ok(backup_bytes), Ok(live_bytes)) if backup_bytes == live_bytes => {
                remove_parked_files(&backup, &sidecar);
                Ok(None)
            }
            _ => {
                // A later canonical restore could resurrect stale content after live deletion.
                Ok(Some(RecoveredBackup {
                    leaf: leaf.to_owned(),
                    backup,
                    sidecar,
                }))
            }
        },
        Err(error) => Err(error),
    }
}

/// Removes the temp files a crash mid-save left behind. Each is a hidden copy of
/// a note that was either installed already or never acknowledged, so nothing in
/// it is the only copy. Only regular files older than `STALE_TEMP_AGE_MS` go: a
/// save in another process (the CLI holds no vault guard) may be using a young
/// one, and its mtime moves while it is written. Sync and the list cache never
/// see a temp, as every walk skips dot-names.
fn sweep_stale_temps(dir: &Path, names: Vec<String>) {
    let now = now_ms();
    for name in names {
        let path = dir.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_file() && now - file_mtime_ms(&metadata) >= STALE_TEMP_AGE_MS {
            let _ = fs::remove_file(&path);
        }
    }
}

fn remove_parked_files(backup: &Path, sidecar: &Path) {
    let _ = fs::remove_file(backup);
    let _ = fs::remove_file(sidecar);
}

fn remove_orphan_sidecars(dir: &Path, sidecars: Vec<String>) {
    for name in sidecars {
        let base = name.trim_end_matches(BACKUP_SIDECAR_SUFFIX);
        if !dir.join(base).exists() {
            let _ = fs::remove_file(dir.join(name));
        }
    }
}

pub(super) fn install_temp(temp: &Path, destination: &Path) -> Result<(), String> {
    let first_error = match fs::rename(temp, destination) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    let parent = destination
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    let parked = park_destinations(parent, destination);
    if parked.is_empty() {
        return Err(format!(
            "{first_error} (renaming {} -> {})",
            temp.display(),
            destination.display()
        ));
    }

    if let Err(error) = fs::rename(temp, destination) {
        for (original, backup) in parked {
            let _ = fs::rename(&backup, original);
            let _ = fs::remove_file(sidecar_of(&backup));
        }
        return Err(format!(
            "{error} (installing {} after collision recovery)",
            destination.display()
        ));
    }
    for (_, backup) in parked {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_file(sidecar_of(&backup));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_parked_backup(
        root: &Path,
        suffix: &str,
        leaf: &str,
        content: &str,
    ) -> (PathBuf, PathBuf) {
        let backup = root.join(format!("{BACKUP_PREFIX}{suffix}"));
        let sidecar = sidecar_of(&backup);
        fs::write(&backup, content).unwrap();
        fs::write(&sidecar, leaf).unwrap();
        (backup, sidecar)
    }

    #[test]
    fn recover_restores_a_note_stranded_in_a_parked_backup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let (backup, sidecar) = write_parked_backup(root, "1-2-3", "Welcome.md", "stranded bytes");
        assert!(!root.join("Welcome.md").exists());

        let recovered = recover_parked_backups(root);

        assert!(
            recovered.is_empty(),
            "a clean canonical restore returns nothing"
        );
        assert_eq!(
            fs::read_to_string(root.join("Welcome.md")).unwrap(),
            "stranded bytes",
            "the stranded note must be restored to its canonical name"
        );
        assert!(!backup.exists());
        assert!(!sidecar.exists());
    }

    #[test]
    fn recover_drops_a_backup_identical_to_the_returned_note() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let (backup, sidecar) = write_parked_backup(root, "9-9-9", "Welcome.md", "same bytes");
        fs::write(root.join("Welcome.md"), "same bytes").unwrap();

        let recovered = recover_parked_backups(root);

        assert!(recovered.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("Welcome.md")).unwrap(),
            "same bytes"
        );
        assert!(!backup.exists());
        assert!(!sidecar.exists());
    }

    #[test]
    fn recover_returns_a_divergent_backup_as_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let (backup, sidecar) =
            write_parked_backup(root, "8-8-8", "Welcome.md", "stranded original");
        fs::write(root.join("Welcome.md"), "newcomer bytes").unwrap();

        let recovered = recover_parked_backups(root);

        assert_eq!(
            fs::read_to_string(root.join("Welcome.md")).unwrap(),
            "newcomer bytes",
            "the newcomer must never be clobbered"
        );
        assert_eq!(
            recovered.len(),
            1,
            "the divergent backup is returned for parking"
        );
        assert_eq!(recovered[0].leaf, "Welcome.md");
        assert_eq!(
            fs::read_to_string(&recovered[0].backup).unwrap(),
            "stranded original",
            "the divergent content is preserved on disk for the caller"
        );
        assert_eq!(recovered[0].sidecar, sidecar);
        assert!(backup.exists());
        assert!(sidecar.exists());
    }

    #[cfg(unix)]
    #[test]
    fn recover_does_not_follow_directory_symlinks_into_a_loop() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write_parked_backup(root, "1-1-1", "Note.md", "loop-safe bytes");
        std::os::unix::fs::symlink(root, root.join("loop")).unwrap();

        let _ = recover_parked_backups(root);

        assert_eq!(
            fs::read_to_string(root.join("Note.md")).unwrap(),
            "loop-safe bytes"
        );
    }

    #[test]
    fn recover_removes_orphan_sidecars() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join(".sf-bak-orphan.path"), "Ghost.md").unwrap();

        let _ = recover_parked_backups(root);

        assert!(!root.join(".sf-bak-orphan.path").exists());
        assert!(!root.join("Ghost.md").exists());
    }

    #[test]
    fn recover_recurses_into_folders() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let sub = root.join("Folder");
        fs::create_dir_all(&sub).unwrap();
        let (backup, _) = write_parked_backup(&sub, "5-5-5", "Deep.md", "sub bytes");

        let _ = recover_parked_backups(root);

        assert_eq!(
            fs::read_to_string(sub.join("Deep.md")).unwrap(),
            "sub bytes"
        );
        assert!(!backup.exists());
    }

    fn write_temp(dir: &Path, name: &str, age_ms: i64) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "a copy of a note").unwrap();
        crate::files::set_file_mtime_ms(&path, now_ms() - age_ms).unwrap();
        path
    }

    #[test]
    fn recover_sweeps_the_temp_a_crash_left_behind() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let sub = root.join("Folder");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join("Note.md"), "installed").unwrap();
        let stale = write_temp(root, ".sf-tmp-4242-1-0", 2 * STALE_TEMP_AGE_MS);
        let nested = write_temp(&sub, ".sf-tmp-4242-1-1", 2 * STALE_TEMP_AGE_MS);

        let _ = recover_parked_backups(root);

        assert!(!stale.exists());
        assert!(!nested.exists());
        assert_eq!(
            fs::read_to_string(root.join("Note.md")).unwrap(),
            "installed"
        );
    }

    /// A save in another process may be using a young temp; so may a rename hop,
    /// which holds the only copy of its note.
    #[test]
    fn recover_leaves_a_live_temp_and_a_rename_hop_alone() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let young = write_temp(root, ".sf-tmp-4242-1-0", 1_000);
        let hop = write_temp(root, ".sf-hop-4242-1-1", 2 * STALE_TEMP_AGE_MS);

        let _ = recover_parked_backups(root);

        assert!(young.exists());
        assert_eq!(fs::read_to_string(hop).unwrap(), "a copy of a note");
    }
}
