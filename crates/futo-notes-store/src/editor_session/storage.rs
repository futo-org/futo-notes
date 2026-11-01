use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use futo_notes_core::files::vault_fs;

/// Recovery I/O below the store workflow. `append` succeeds only after every
/// byte is accepted by the OS; an error may leave a partial, unaccepted tail.
/// `flush` persists the file and all directory entries needed to find it.
/// Implementations must retain vault path/symlink safety and report failures.
pub trait RecoveryStorage: Send {
    /// Optional bounded-entry capability. Success owns this exact inactive file
    /// and probes an exclusive no-copy install; ordinary full workflows do not
    /// require it. Preparation must not install the canonical stream.
    /// Failure leaves ordinary full recovery usable; any partial inactive bytes
    /// remain inert and must not become an append target without a new success.
    fn prepare_bounded_stream(
        &mut self,
        _root: &Path,
        _inactive: &str,
        _canonical: &str,
        _header: &[u8],
    ) -> Result<(), String> {
        Err("no-copy recovery activation unsupported".into())
    }
    /// Errors mean no installation. An installed receipt retains its effect
    /// separately from a later directory durability failure.
    fn activate_bounded_stream(
        &mut self,
        _root: &Path,
    ) -> Result<vault_fs::RecoveryActivation, String> {
        Err("no prepared recovery stream".into())
    }
    fn verify_bounded_stream(&mut self, _root: &Path, _path: &str) -> Result<(), String> {
        Err("no prepared recovery stream".into())
    }
    fn deactivate_bounded_stream(&mut self, _root: &Path) -> Result<(), String> {
        Err("no prepared recovery stream".into())
    }
    fn discard_bounded_stream(&mut self, _root: &Path) -> Result<(), String> {
        Err("no prepared recovery stream".into())
    }
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
    prepared: Option<(PathBuf, vault_fs::PreparedRecoveryActivation)>,
}

impl RecoveryStorage for VaultRecoveryStorage {
    fn prepare_bounded_stream(
        &mut self,
        root: &Path,
        inactive: &str,
        canonical: &str,
        header: &[u8],
    ) -> Result<(), String> {
        if self.prepared.is_some() {
            return Err("recovery preparation already owned".into());
        }
        self.create(root, inactive, header)?;
        self.flush(root, inactive)?;
        // A failed probe leaves only inert metadata. Without a returned pinned
        // identity it is deliberately retained rather than guessed safe to unlink.
        let prepared = vault_fs::prepare_recovery_activation(root, inactive, canonical)
            .map_err(|error| error.to_string())?;
        self.prepared = Some((root.to_owned(), prepared));
        Ok(())
    }
    fn activate_bounded_stream(
        &mut self,
        root: &Path,
    ) -> Result<vault_fs::RecoveryActivation, String> {
        self.prepared
            .as_mut()
            .ok_or("no prepared recovery stream")?
            .1
            .activate(root)
    }
    fn verify_bounded_stream(&mut self, root: &Path, path: &str) -> Result<(), String> {
        self.prepared
            .as_ref()
            .ok_or("no prepared recovery stream")?
            .1
            .verify(root, path)
    }
    fn deactivate_bounded_stream(&mut self, root: &Path) -> Result<(), String> {
        self.prepared
            .as_mut()
            .ok_or("no prepared recovery stream")?
            .1
            .deactivate(root)
    }
    fn discard_bounded_stream(&mut self, root: &Path) -> Result<(), String> {
        self.file = None;
        self.prepared
            .as_mut()
            .ok_or("no prepared recovery stream")?
            .1
            .discard(root)?;
        self.prepared = None;
        Ok(())
    }
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

impl Drop for VaultRecoveryStorage {
    fn drop(&mut self) {
        // Inactive metadata is not recovery authority. The capability checks
        // exact parent/inode ownership and never removes the canonical stream.
        if let Some((root, prepared)) = &mut self.prepared {
            if let Err(error) = prepared.discard(root) {
                futo_notes_core::log_to_stderr!("inactive editor recovery cleanup: {error}");
            }
        }
    }
}
