use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::atomic_write::move_no_replace;
use super::filenames::collision_key;
use super::paths::MAX_FOLDER_DEPTH;
use super::timestamps::now_ms;

const BACKUP_PREFIX: &str = ".sf-bak-";
const BACKUP_SIDECAR_SUFFIX: &str = ".path";

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
    let mut recovered = Vec::new();
    recover_parked_in(root, 0, &mut recovered);
    recovered
}

fn recover_parked_in(dir: &Path, depth: usize, recovered: &mut Vec<RecoveredBackup>) {
    let Some(entries) = scan_parked_entries(dir) else {
        return;
    };

    for name in entries.backups {
        if let Some(backup) = recover_parked_backup(dir, &name) {
            recovered.push(backup);
        }
    }
    remove_orphan_sidecars(dir, entries.sidecars);

    if depth >= MAX_FOLDER_DEPTH {
        return;
    }
    for subdir in entries.subdirs {
        recover_parked_in(&subdir, depth + 1, recovered);
    }
}

struct ParkedEntries {
    subdirs: Vec<PathBuf>,
    backups: Vec<String>,
    sidecars: Vec<String>,
}

fn scan_parked_entries(dir: &Path) -> Option<ParkedEntries> {
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    let mut backups = Vec::new();
    let mut sidecars = Vec::new();
    for entry in entries.flatten() {
        // Do not follow directory symlinks; a vault-local loop would overflow bootstrap recovery.
        let real_dir = fs::symlink_metadata(entry.path())
            .map(|meta| meta.file_type().is_dir())
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
            }
        }
    }
    Some(ParkedEntries {
        subdirs,
        backups,
        sidecars,
    })
}

fn recover_parked_backup(dir: &Path, name: &str) -> Option<RecoveredBackup> {
    let backup = dir.join(name);
    let sidecar = dir.join(format!("{name}{BACKUP_SIDECAR_SUFFIX}"));
    let leaf = fs::read_to_string(&sidecar).ok()?;
    let leaf = leaf.trim();
    if leaf.is_empty() || leaf.contains('/') || leaf.contains('\\') {
        return None;
    }
    let destination = dir.join(leaf);
    // A no-replace move also works on Android storage, where hard links are denied.
    match move_no_replace(&backup, &destination) {
        Ok(true) => {
            let _ = fs::remove_file(&sidecar);
            None
        }
        Ok(false) => {
            match (fs::read(&backup), fs::read(&destination)) {
                (Ok(backup_bytes), Ok(live_bytes)) if backup_bytes == live_bytes => {
                    remove_parked_files(&backup, &sidecar);
                    None
                }
                _ => {
                    // A later canonical restore could resurrect stale content after live deletion.
                    Some(RecoveredBackup {
                        leaf: leaf.to_owned(),
                        backup,
                        sidecar,
                    })
                }
            }
        }
        Err(_) => None,
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
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-parked-backup-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

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
        let root = temp_dir();
        let (backup, sidecar) = write_parked_backup(&root, "1-2-3", "Welcome.md", "stranded bytes");
        assert!(!root.join("Welcome.md").exists());

        let recovered = recover_parked_backups(&root);

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
        let root = temp_dir();
        let (backup, sidecar) = write_parked_backup(&root, "9-9-9", "Welcome.md", "same bytes");
        fs::write(root.join("Welcome.md"), "same bytes").unwrap();

        let recovered = recover_parked_backups(&root);

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
        let root = temp_dir();
        let (backup, sidecar) =
            write_parked_backup(&root, "8-8-8", "Welcome.md", "stranded original");
        fs::write(root.join("Welcome.md"), "newcomer bytes").unwrap();

        let recovered = recover_parked_backups(&root);

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
        let root = temp_dir();
        write_parked_backup(&root, "1-1-1", "Note.md", "loop-safe bytes");
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();

        let _ = recover_parked_backups(&root);

        assert_eq!(
            fs::read_to_string(root.join("Note.md")).unwrap(),
            "loop-safe bytes"
        );
    }

    #[test]
    fn recover_removes_orphan_sidecars() {
        let root = temp_dir();
        fs::write(root.join(".sf-bak-orphan.path"), "Ghost.md").unwrap();

        let _ = recover_parked_backups(&root);

        assert!(!root.join(".sf-bak-orphan.path").exists());
        assert!(!root.join("Ghost.md").exists());
    }

    #[test]
    fn recover_recurses_into_folders() {
        let root = temp_dir();
        let sub = root.join("Folder");
        fs::create_dir_all(&sub).unwrap();
        let (backup, _) = write_parked_backup(&sub, "5-5-5", "Deep.md", "sub bytes");

        let _ = recover_parked_backups(&root);

        assert_eq!(
            fs::read_to_string(sub.join("Deep.md")).unwrap(),
            "sub bytes"
        );
        assert!(!backup.exists());
    }
}
