use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use futo_notes_core::conflict_names::{collision_conflict_filename, conflict_filename};
use futo_notes_core::files::{
    file_mtime_ms, read_blob_as_base64, write_atomic_text, write_base64_as_blob,
};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::{is_image_filename, is_syncable_filename};

use super::PreWrite;

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
        let metadata = std::fs::metadata(path)?;
        Ok(ScanMetadata {
            is_dir: metadata.is_dir(),
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

fn local_files_with(root: &Path, scanner: &impl FileScanner) -> Result<Vec<LocalFile>, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        scanner: &impl FileScanner,
        files: &mut Vec<LocalFile>,
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
            if metadata.is_dir {
                walk(root, &entry.path, scanner, files)?;
                continue;
            }
            let relative = entry.path.strip_prefix(root).map_err(|error| {
                format!(
                    "local vault scan found path outside {}: {} ({error})",
                    root.display(),
                    entry.path.display()
                )
            })?;
            let name = relative.to_string_lossy().replace('\\', "/");
            if !is_syncable_filename(&name) {
                continue;
            }
            files.push(LocalFile {
                name,
                mtime: metadata.mtime,
                size: metadata.size,
            });
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, scanner, &mut files)?;
    files.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(files)
}

pub(super) fn local_files(root: &Path) -> Result<Vec<LocalFile>, String> {
    local_files_with(root, &RealFileScanner)
}

pub(super) fn read_content(root: &Path, name: &str) -> Result<String, String> {
    let path = root.join(name);
    if is_image_filename(name) {
        read_blob_as_base64(&path)
    } else {
        std::fs::read_to_string(path).map_err(|error| error.to_string())
    }
}

pub(super) fn write_content(
    root: &Path,
    name: &str,
    content: &str,
    pre_write: &PreWrite,
) -> Result<(), String> {
    pre_write(name);
    let path = root.join(name);
    if is_image_filename(name) {
        write_base64_as_blob(&path, content)
    } else {
        write_atomic_text(&path, content)
    }
}

pub(super) fn remove_local(root: &Path, name: &str, pre_write: &PreWrite) -> Result<bool, String> {
    pre_write(name);
    match std::fs::remove_file(root.join(name)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
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
    if root.join(&target).exists() {
        let names: HashSet<_> = local_files(root)?
            .into_iter()
            .map(|file| file.name)
            .collect();
        target = conflict_filename(name, &conflict_date(), &names);
    }
    pre_write(name);
    pre_write(&target);
    if let Some(parent) = root.join(&target).parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(root.join(name), root.join(&target)).map_err(|error| error.to_string())?;
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
}
