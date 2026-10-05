use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futo_notes_core::conflict_names::{collision_conflict_filename, conflict_filename};
use futo_notes_core::files::{file_mtime_ms, vault_mutation_guard};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::{is_image_filename, is_syncable_filename};

use super::vault_fs;
use super::PreWrite;

mod guarded_write;

pub(super) use guarded_write::{
    copy_content_if_hash_matches, replace_content_if_hash_matches,
    write_content_if_source_and_target_absent, GuardedWriteOutcome,
};

#[derive(Clone, Debug)]
pub(super) struct LocalFile {
    pub(super) name: String,
    pub(super) mtime: i64,
    pub(super) size: u64,
}

struct ScanEntry {
    path: PathBuf,
    file_name: OsString,
}

struct ScanMetadata {
    is_dir: bool,
    is_symlink: bool,
    mtime: i64,
    size: u64,
}

trait FileScanner {
    fn entries(&self, dir: &Path) -> std::io::Result<Vec<std::io::Result<ScanEntry>>>;
    fn metadata(&self, path: &Path) -> std::io::Result<ScanMetadata>;
}

struct RealFileScanner;

impl FileScanner for RealFileScanner {
    fn entries(&self, dir: &Path) -> std::io::Result<Vec<std::io::Result<ScanEntry>>> {
        Ok(std::fs::read_dir(dir)?
            .map(|entry| {
                entry.map(|entry| ScanEntry {
                    path: entry.path(),
                    file_name: entry.file_name(),
                })
            })
            .collect())
    }

    fn metadata(&self, path: &Path) -> std::io::Result<ScanMetadata> {
        let metadata = std::fs::symlink_metadata(path)?;
        Ok(ScanMetadata {
            is_dir: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            mtime: file_mtime_ms(&metadata),
            size: metadata.len(),
        })
    }
}

fn scan_error(operation: &str, path: &Path, error: std::io::Error) -> String {
    format!(
        "local vault scan failed to {operation} {}: {error}",
        path.display()
    )
}

/// Every file sync can name, plus the display names of the syncable files it
/// cannot (a filename that is not UTF-8), which push journals instead of
/// dropping them silently.
#[derive(Debug, Default)]
pub(super) struct LocalScan {
    pub(super) files: Vec<LocalFile>,
    pub(super) unnamed: Vec<String>,
}

fn local_files_with(root: &Path, scanner: &impl FileScanner) -> Result<LocalScan, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        scanner: &impl FileScanner,
        scan: &mut LocalScan,
    ) -> Result<(), String> {
        let entries = scanner
            .entries(dir)
            .map_err(|error| scan_error("read directory", dir, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| scan_error("read entry in", dir, error))?;
            let name = entry.file_name;
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let metadata = scanner
                .metadata(&entry.path)
                .map_err(|error| scan_error("read metadata for", &entry.path, error))?;
            if metadata.is_symlink {
                continue;
            }
            if metadata.is_dir {
                walk(root, &entry.path, scanner, scan)?;
                continue;
            }
            let relative = entry.path.strip_prefix(root).map_err(|error| {
                format!(
                    "local vault scan found path outside {}: {} ({error})",
                    root.display(),
                    entry.path.display()
                )
            })?;
            // The name vault_fs resolves back to this file. A lossy one (a Unix
            // `\` read as a separator, bytes that are not UTF-8) named another
            // file or none, and failing to read it failed every push.
            let Some(name) = vault_fs::relative_name(root, &entry.path) else {
                let lossy = relative.to_string_lossy().into_owned();
                if is_syncable_filename(&lossy) {
                    scan.unnamed.push(lossy);
                }
                continue;
            };
            if !is_syncable_filename(&name) {
                continue;
            }
            scan.files.push(LocalFile {
                name,
                mtime: metadata.mtime,
                size: metadata.size,
            });
        }
        Ok(())
    }
    let mut scan = LocalScan::default();
    walk(root, root, scanner, &mut scan)?;
    scan.files.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(scan)
}

pub(super) fn local_scan(root: &Path) -> Result<LocalScan, String> {
    local_files_with(root, &RealFileScanner)
}

pub(super) fn local_files(root: &Path) -> Result<Vec<LocalFile>, String> {
    local_scan(root).map(|scan| scan.files)
}

pub(super) fn read_content(root: &Path, name: &str) -> Result<String, String> {
    let bytes = vault_fs::read(root, name)?;
    if is_image_filename(name) {
        Ok(BASE64.encode(bytes))
    } else {
        String::from_utf8(bytes).map_err(|error| error.to_string())
    }
}

fn content_bytes(name: &str, content: &str) -> Result<Vec<u8>, String> {
    let bytes = if is_image_filename(name) {
        BASE64
            .decode(content)
            .map_err(|error| format!("invalid base64 image: {error}"))?
    } else {
        content.as_bytes().to_vec()
    };
    Ok(bytes)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PulledWrite {
    Written,
    AlreadyCurrent,
    /// The file no longer holds `local_base`: a local save landed. Nothing written.
    LocalChanged,
}

/// Commit one pulled object under the same guard as both of its hash checks.
/// `local_base` is the hash the object map records for the file; a file that
/// holds neither it nor `expected_hash` is a local save and is never replaced.
/// The check and the write share one guard hold because the editor's save takes
/// the same guard: checked outside it, a save landing in between was overwritten
/// by the remote text (RC-93).
pub(super) fn write_content_if_changed(
    root: &Path,
    name: &str,
    content: &str,
    expected_hash: &str,
    local_base: Option<&str>,
    modified_ms: i64,
    pre_write: &PreWrite,
) -> Result<PulledWrite, String> {
    let bytes = content_bytes(name, content)?;
    pre_write(name);
    let _vault_mutation = vault_mutation_guard()?;
    let current = content_hash(root, name);
    let changed = current.as_deref() != Some(expected_hash);
    if changed && local_base.is_some_and(|base| current.as_deref() != Some(base)) {
        return Ok(PulledWrite::LocalChanged);
    }
    if changed {
        vault_fs::write_atomic(root, name, &bytes)?;
    } else {
        vault_fs::sync_parent(root, name)?;
    }
    if modified_ms > 0 {
        if changed {
            pre_write(name);
        }
        let _ = vault_fs::set_mtime_ms(root, name, modified_ms);
    }
    Ok(if changed {
        PulledWrite::Written
    } else {
        PulledWrite::AlreadyCurrent
    })
}

pub(super) fn remove_local(root: &Path, name: &str, pre_write: &PreWrite) -> Result<bool, String> {
    pre_write(name);
    let _vault_mutation = vault_mutation_guard()?;
    vault_fs::remove(root, name)
}

pub(super) fn path_exists(root: &Path, name: &str) -> Result<bool, String> {
    vault_fs::exists(root, name)
}

pub(super) fn rename_local(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    let _vault_mutation = vault_mutation_guard()?;
    vault_fs::rename(root, source, destination)
}

pub(super) fn conflict_date() -> String {
    futo_notes_core::conflict_names::current_conflict_date()
}

pub(super) fn park_local(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<String, String> {
    let mut target = collision_conflict_filename(name, object_id);
    if path_exists(root, &target)? {
        let names: HashSet<_> = local_files(root)?
            .into_iter()
            .map(|file| file.name)
            .collect();
        target = conflict_filename(name, &conflict_date(), &names);
    }
    pre_write(name);
    pre_write(&target);
    if !rename_local(root, name, &target)? {
        return Err(format!("rename source disappeared: {name}"));
    }
    Ok(target)
}

pub(super) fn content_hash(root: &Path, name: &str) -> Option<String> {
    read_content(root, name)
        .ok()
        .map(|content| hash_sha256(&content))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-vault-test-{}-{n}",
                futo_notes_core::files::now_ms()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn watcher_registration_precedes_write_park_and_remove_mutations() {
        let root = TempRoot::new();
        let note = root.0.join("note.md");
        std::fs::write(&note, "old body").unwrap();

        let write_calls = Arc::new(Mutex::new(Vec::new()));
        let callback_calls = Arc::clone(&write_calls);
        let callback_note = note.clone();
        let before_write = move |name: &str| {
            callback_calls.lock().unwrap().push(name.to_owned());
            assert_eq!(std::fs::read_to_string(&callback_note).unwrap(), "old body");
        };
        write_content_if_changed(&root.0, "note.md", "new body", "", None, 0, &before_write)
            .unwrap();
        assert_eq!(write_calls.lock().unwrap().as_slice(), ["note.md"]);
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "new body");

        let parked_name = collision_conflict_filename("note.md", "object-1");
        let parked = root.0.join(&parked_name);
        let park_calls = Arc::new(Mutex::new(Vec::new()));
        let callback_calls = Arc::clone(&park_calls);
        let callback_note = note.clone();
        let callback_parked = parked.clone();
        let before_park = move |name: &str| {
            callback_calls.lock().unwrap().push(name.to_owned());
            assert_eq!(std::fs::read_to_string(&callback_note).unwrap(), "new body");
            assert!(!callback_parked.exists());
        };
        assert_eq!(
            park_local(&root.0, "note.md", "object-1", &before_park).unwrap(),
            parked_name
        );
        assert_eq!(
            park_calls.lock().unwrap().as_slice(),
            ["note.md", parked_name.as_str()]
        );
        assert!(!note.exists());
        assert_eq!(std::fs::read_to_string(&parked).unwrap(), "new body");

        let remove_calls = Arc::new(Mutex::new(Vec::new()));
        let callback_calls = Arc::clone(&remove_calls);
        let callback_parked = parked.clone();
        let before_remove = move |name: &str| {
            callback_calls.lock().unwrap().push(name.to_owned());
            assert_eq!(
                std::fs::read_to_string(&callback_parked).unwrap(),
                "new body"
            );
        };
        assert!(remove_local(&root.0, &parked_name, &before_remove).unwrap());
        assert_eq!(remove_calls.lock().unwrap().as_slice(), [parked_name]);
        assert!(!parked.exists());
    }

    enum Fault {
        ReadDirectory(PathBuf),
        ReadEntry(PathBuf),
        Metadata(PathBuf),
    }

    struct FaultingScanner {
        fault: Fault,
    }

    impl FileScanner for FaultingScanner {
        fn entries(&self, dir: &Path) -> std::io::Result<Vec<std::io::Result<ScanEntry>>> {
            match &self.fault {
                Fault::ReadDirectory(path) if path == dir => {
                    Err(std::io::Error::other("injected read_dir failure"))
                }
                Fault::ReadEntry(path) if path == dir => {
                    Ok(vec![Err(std::io::Error::other("injected entry failure"))])
                }
                _ => RealFileScanner.entries(dir),
            }
        }

        fn metadata(&self, path: &Path) -> std::io::Result<ScanMetadata> {
            match &self.fault {
                Fault::Metadata(failed) if failed == path => {
                    Err(std::io::Error::other("injected metadata failure"))
                }
                _ => RealFileScanner.metadata(path),
            }
        }
    }

    #[test]
    fn scan_reports_root_directory_failure() {
        let root = TempRoot::new();
        let error = local_files_with(
            &root.0,
            &FaultingScanner {
                fault: Fault::ReadDirectory(root.0.clone()),
            },
        )
        .unwrap_err();

        assert!(error.contains("read directory"));
        assert!(error.contains(root.0.to_string_lossy().as_ref()));
    }

    #[test]
    fn scan_reports_nested_directory_failure() {
        let root = TempRoot::new();
        let nested = root.0.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let error = local_files_with(
            &root.0,
            &FaultingScanner {
                fault: Fault::ReadDirectory(nested.clone()),
            },
        )
        .unwrap_err();

        assert!(error.contains("read directory"));
        assert!(error.contains(nested.to_string_lossy().as_ref()));
    }

    #[test]
    fn scan_reports_directory_entry_failure() {
        let root = TempRoot::new();
        let error = local_files_with(
            &root.0,
            &FaultingScanner {
                fault: Fault::ReadEntry(root.0.clone()),
            },
        )
        .unwrap_err();

        assert!(error.contains("read entry"));
        assert!(error.contains(root.0.to_string_lossy().as_ref()));
    }

    #[test]
    fn scan_reports_metadata_failure() {
        let root = TempRoot::new();
        let note = root.0.join("note.md");
        std::fs::write(&note, "body").unwrap();
        let error = local_files_with(
            &root.0,
            &FaultingScanner {
                fault: Fault::Metadata(note.clone()),
            },
        )
        .unwrap_err();

        assert!(error.contains("read metadata"));
        assert!(error.contains(note.to_string_lossy().as_ref()));
    }

    #[cfg(unix)]
    #[test]
    fn scan_never_follows_file_or_directory_symlinks_outside_the_vault() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new();
        let outside = TempRoot::new();
        std::fs::write(outside.0.join("secret.md"), "outside").unwrap();
        symlink(outside.0.join("secret.md"), root.0.join("linked-file.md")).unwrap();
        symlink(&outside.0, root.0.join("linked-directory")).unwrap();

        let names = local_files(&root.0)
            .unwrap()
            .into_iter()
            .map(|file| file.name)
            .collect::<Vec<_>>();

        assert!(
            names.is_empty(),
            "symlinked paths leaked into sync: {names:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn content_reads_never_follow_file_or_parent_symlinks() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new();
        let outside = TempRoot::new();
        let secret = outside.0.join("secret.md");
        std::fs::write(&secret, "outside").unwrap();
        symlink(&secret, root.0.join("linked-file.md")).unwrap();
        symlink(&outside.0, root.0.join("linked-directory")).unwrap();

        assert!(read_content(&root.0, "linked-file.md").is_err());
        assert!(read_content(&root.0, "linked-directory/secret.md").is_err());
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "outside");
    }

    #[cfg(unix)]
    #[test]
    fn content_removals_never_follow_symlinked_parents() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new();
        let outside = TempRoot::new();
        let secret = outside.0.join("secret.md");
        std::fs::write(&secret, "outside").unwrap();
        symlink(&outside.0, root.0.join("linked-directory")).unwrap();

        assert!(remove_local(&root.0, "linked-directory/secret.md", &|_| {}).is_err());
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "outside");
    }

    #[cfg(unix)]
    #[test]
    fn content_renames_never_follow_symlinked_parents() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new();
        let outside = TempRoot::new();
        let secret = outside.0.join("secret.md");
        std::fs::write(&secret, "outside").unwrap();
        symlink(&outside.0, root.0.join("linked-directory")).unwrap();

        assert!(park_local(
            &root.0,
            "linked-directory/secret.md",
            "outside-object",
            &|_| {}
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "outside");
        assert_eq!(std::fs::read_dir(&outside.0).unwrap().count(), 1);
    }
}
