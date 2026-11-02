use std::fs::File;
use std::io::Write;
use std::path::Path;

use futo_notes_core::files::vault_fs;

/// Recovery I/O below the store workflow. `append` succeeds only after every
/// byte is accepted by the OS; an error may leave a partial, unaccepted tail.
/// `flush` persists the file and all directory entries needed to find it.
/// Implementations must retain vault path/symlink safety and report failures.
pub trait RecoveryStorage: Send {
    /// Hidden recovery metadata available for interrupted identity discovery.
    fn list(&mut self, root: &Path) -> Result<Vec<String>, String> {
        vault_fs::validate_path(root, ".futo-editor-recovery")?;
        let entries = match std::fs::read_dir(root.join(".futo-editor-recovery")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        entries
            .map(|entry| {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "invalid recovery metadata filename".to_owned())?;
                Ok(format!(".futo-editor-recovery/{name}"))
            })
            .collect()
    }
    fn read(&mut self, root: &Path, path: &str) -> Result<Option<Vec<u8>>, String>;
    fn create(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String>;
    /// Atomically replace metadata with complete old-or-new bytes. Callers
    /// retain their intent until a subsequent successful durable flush.
    fn replace(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String>;
    fn append(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String>;
    fn truncate(&mut self, root: &Path, path: &str, length: u64) -> Result<(), String>;
    fn flush(&mut self, root: &Path, path: &str) -> Result<(), String>;
    /// Success includes durable removal; retrying an absent path still syncs
    /// its directory so interrupted retirement is safe to repeat.
    fn remove(&mut self, root: &Path, path: &str) -> Result<(), String>;
}

#[derive(Default)]
pub(super) struct VaultRecoveryStorage {
    file: Option<File>,
}

impl RecoveryStorage for VaultRecoveryStorage {
    fn read(&mut self, root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
        vault_fs::read_optional(root, path)
    }
    fn create(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        if !vault_fs::create_new(root, path, bytes)? {
            return Err("editor recovery stream already exists".to_owned());
        }
        Ok(())
    }
    fn replace(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.file = None;
        vault_fs::write_atomic(root, path, bytes)
    }
    fn append(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        if self.file.is_none() {
            self.file = Some(vault_fs::open_append(root, path)?);
        }
        self.file
            .as_mut()
            .unwrap()
            .write_all(bytes)
            .map_err(|error| error.to_string())
    }
    fn truncate(&mut self, root: &Path, path: &str, length: u64) -> Result<(), String> {
        self.file = None;
        vault_fs::open_append(root, path)?
            .set_len(length)
            .map_err(|error| error.to_string())
    }
    fn flush(&mut self, root: &Path, path: &str) -> Result<(), String> {
        vault_fs::sync_file(root, path)?;
        vault_fs::sync_parent(root, path)?;
        vault_fs::sync_parent(root, ".futo-editor-recovery")
    }
    fn remove(&mut self, root: &Path, path: &str) -> Result<(), String> {
        self.file = None;
        vault_fs::remove(root, path)?;
        Ok(())
    }
}
