use std::fs::File;
use std::io::Write;
use std::path::Path;

use futo_notes_core::files::vault_fs;

/// Recovery I/O below the store workflow. `append` succeeds only after every
/// byte is accepted by the OS; an error may leave a partial, unaccepted tail.
/// `flush` persists the file and all directory entries needed to find it.
/// Implementations must retain vault path/symlink safety and report failures.
pub trait RecoveryStorage: Send {
    /// Optional bounded-entry capability: exclusively create `path`, write
    /// and durably flush `header`, and keep that inode pinned. Later `append`,
    /// `truncate`, `flush` and `remove` of `path` use the pinned inode. On
    /// error the implementation removes what it created where it can; any
    /// pin it still holds is released only by `remove_reservation`.
    fn reserve(&mut self, _root: &Path, _path: &str, _header: &[u8]) -> Result<(), String> {
        Err("bounded recovery reservation unsupported".into())
    }
    /// Pin an existing stream and return its bytes read through that inode.
    fn pin(&mut self, _root: &Path, _path: &str) -> Result<Option<Vec<u8>>, String> {
        Err("bounded recovery reservation unsupported".into())
    }
    /// Retire a strictly clean reservation by path on platforms that cannot
    /// pin: remove `path` only while its bytes equal `expected`; an absent
    /// stream is already retired.
    fn retire_unpinned(
        &mut self,
        _root: &Path,
        _path: &str,
        _expected: &[u8],
    ) -> Result<(), String> {
        Err("bounded recovery reservation unsupported".into())
    }
    /// Forget a pin without touching the file.
    fn release_pin(&mut self) {}
    /// The canonical name and parent still name the pinned inode.
    fn verify_reservation(&mut self, _root: &Path) -> Result<(), String> {
        Err("no pinned recovery stream".into())
    }
    /// `true` after the pinned inode's canonical name was found already
    /// unlinked: its removal is made durable and the pin released. `false`
    /// while the name still owns the pin; foreign bytes there are an error.
    fn reservation_removed(&mut self, _root: &Path) -> Result<bool, String> {
        Ok(false)
    }
    /// Durably remove only the verified pinned inode, then release the pin.
    /// Succeeds without effect when nothing is pinned.
    fn remove_reservation(&mut self, _root: &Path) -> Result<(), String> {
        Ok(())
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
    pinned: Option<(String, vault_fs::PinnedRecoveryFile)>,
}

impl VaultRecoveryStorage {
    fn pinned(&mut self, path: &str) -> Option<&mut vault_fs::PinnedRecoveryFile> {
        self.pinned
            .as_mut()
            .filter(|(pinned, _)| pinned == path)
            .map(|(_, file)| file)
    }
}

impl RecoveryStorage for VaultRecoveryStorage {
    fn reserve(&mut self, root: &Path, path: &str, header: &[u8]) -> Result<(), String> {
        if self.pinned.is_some() {
            return Err("recovery reservation already owned".into());
        }
        let mut file = vault_fs::create_pinned_recovery(root, path)?
            .ok_or("editor recovery stream already exists")?;
        let written = file.append(header).and_then(|()| file.sync());
        if let Err(error) = written {
            // Only the inode this call created is removed; a failed cleanup
            // keeps it pinned for an explicit retry.
            if let Err(cleanup) = file.remove(root) {
                self.pinned = Some((path.to_owned(), file));
                return Err(format!("{error}; reservation cleanup failed: {cleanup}"));
            }
            return Err(error);
        }
        self.file = None;
        self.pinned = Some((path.to_owned(), file));
        Ok(())
    }
    fn pin(&mut self, root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
        if self.pinned.is_some() {
            return Err("recovery reservation already owned".into());
        }
        let Some(file) = vault_fs::open_pinned_recovery(root, path)? else {
            return Ok(None);
        };
        let bytes = file.read_all()?;
        self.file = None;
        self.pinned = Some((path.to_owned(), file));
        Ok(Some(bytes))
    }
    fn retire_unpinned(&mut self, root: &Path, path: &str, expected: &[u8]) -> Result<(), String> {
        self.file = None;
        vault_fs::remove_if_unchanged(root, path, expected).map(|_| ())
    }
    fn release_pin(&mut self) {
        self.pinned = None;
    }
    fn reservation_removed(&mut self, root: &Path) -> Result<bool, String> {
        let Some((_, file)) = &self.pinned else {
            return Ok(false);
        };
        if !file.is_removed(root)? {
            return Ok(false);
        }
        // Absent name: this only makes the earlier unlink durable.
        file.remove(root)?;
        self.pinned = None;
        Ok(true)
    }
    fn verify_reservation(&mut self, root: &Path) -> Result<(), String> {
        self.pinned
            .as_ref()
            .ok_or("no pinned recovery stream")?
            .1
            .verify(root)
    }
    fn remove_reservation(&mut self, root: &Path) -> Result<(), String> {
        if let Some((_, file)) = &self.pinned {
            file.remove(root)?;
            self.pinned = None;
        }
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
        let written = vault_fs::write_atomic(root, path, bytes);
        // A failed write leaves the owned inode canonical, so its pin stays.
        if written.is_ok() && self.pinned(path).is_some() {
            self.pinned = None;
        }
        written
    }
    fn append(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        if let Some(file) = self.pinned(path) {
            return file.append(bytes);
        }
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
        if let Some(file) = self.pinned(path) {
            return file.truncate(length);
        }
        self.file = None;
        vault_fs::open_append(root, path)?
            .set_len(length)
            .map_err(|error| error.to_string())
    }
    fn flush(&mut self, root: &Path, path: &str) -> Result<(), String> {
        if let Some(file) = self.pinned(path) {
            file.sync()?;
        } else {
            vault_fs::sync_file(root, path)?;
            vault_fs::sync_parent(root, path)?;
        }
        vault_fs::sync_parent(root, ".futo-editor-recovery")
    }
    fn remove(&mut self, root: &Path, path: &str) -> Result<(), String> {
        if self.pinned(path).is_some() {
            return self.remove_reservation(root);
        }
        self.file = None;
        vault_fs::remove(root, path)?;
        Ok(())
    }
}
