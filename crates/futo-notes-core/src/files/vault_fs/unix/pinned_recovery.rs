use super::*;
use std::os::unix::fs::{FileExt, MetadataExt};

/// An editor recovery stream pinned to the exact inode this process created or
/// opened, plus its parent directory. Mutation and durability use these
/// descriptors; `verify` proves the canonical name still names them. No hard
/// links or renames are involved.
pub struct PinnedRecoveryFile {
    directory: OwnedFd,
    file: File,
    relative: String,
}

fn recovery_parent(root: &Path, relative: &str, create: bool) -> Result<Option<Parent>, String> {
    let components = relative_components(relative)?;
    if components.len() != 2 || components[0] != ".futo-editor-recovery" {
        return Err("pinned recovery is restricted to editor recovery metadata".into());
    }
    match open_parent(root, relative, create) {
        Ok(parent) => Ok(Some(parent)),
        Err(OpenParentError::NotFound(_)) if !create => Ok(None),
        Err(error) => Err(error.message()),
    }
}

fn pin(
    parent: Parent,
    flags: OFlags,
    relative: &str,
) -> Result<Option<PinnedRecoveryFile>, String> {
    let descriptor = match openat(
        &parent.directory,
        &parent.leaf,
        flags
            | OFlags::RDWR
            | OFlags::APPEND
            | OFlags::NOFOLLOW
            | OFlags::CLOEXEC
            | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    ) {
        Ok(descriptor) => descriptor,
        Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(context("open pinned recovery", relative, error)),
    };
    let file = File::from(descriptor);
    if !file
        .metadata()
        .map_err(|error| context("stat pinned recovery", relative, error))?
        .is_file()
    {
        return Err(format!("pinned recovery is not a regular file: {relative}"));
    }
    Ok(Some(PinnedRecoveryFile {
        directory: parent.directory,
        file,
        relative: relative.to_owned(),
    }))
}

/// Exclusively creates `relative`; `Ok(None)` means the name is occupied and
/// nothing was touched.
pub fn create_pinned_recovery(
    root: &Path,
    relative: &str,
) -> Result<Option<PinnedRecoveryFile>, String> {
    let parent = recovery_parent(root, relative, true)?.expect("created parent");
    pin(parent, OFlags::CREATE | OFlags::EXCL, relative)
}

/// Pins an existing regular file; `Ok(None)` when it is absent.
pub fn open_pinned_recovery(
    root: &Path,
    relative: &str,
) -> Result<Option<PinnedRecoveryFile>, String> {
    match recovery_parent(root, relative, false)? {
        Some(parent) => pin(parent, OFlags::empty(), relative),
        None => Ok(None),
    }
}

fn identity(file: &File) -> Result<(u64, u64), String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    Ok((metadata.dev(), metadata.ino()))
}

impl PinnedRecoveryFile {
    /// `Ok(false)` when the canonical name is absent under the original parent.
    fn canonical_is_owned(&self, root: &Path) -> Result<bool, String> {
        let current = open_parent(root, &self.relative, false).map_err(OpenParentError::message)?;
        let expected = identity(&File::from(
            self.directory.try_clone().map_err(|e| e.to_string())?,
        ))?;
        let actual = identity(&File::from(
            current.directory.try_clone().map_err(|e| e.to_string())?,
        ))?;
        if expected != actual {
            return Err("pinned recovery parent identity changed".into());
        }
        let found = match openat(
            &self.directory,
            &current.leaf,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(found) => File::from(found),
            Err(rustix::io::Errno::NOENT) => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        if !found.metadata().map_err(|e| e.to_string())?.is_file()
            || identity(&found)? != identity(&self.file)?
        {
            return Err("pinned recovery file identity changed".into());
        }
        Ok(true)
    }

    /// The canonical name and its parent still name the pinned descriptors.
    pub fn verify(&self, root: &Path) -> Result<(), String> {
        if !self.canonical_is_owned(root)? {
            return Err("pinned recovery file was removed".into());
        }
        Ok(())
    }

    pub fn read_all(&self) -> Result<Vec<u8>, String> {
        let length = self.file.metadata().map_err(|e| e.to_string())?.len();
        let mut bytes = vec![0; usize::try_from(length).map_err(|e| e.to_string())?];
        self.file
            .read_exact_at(&mut bytes, 0)
            .map_err(|error| context("read pinned recovery", &self.relative, error))?;
        Ok(bytes)
    }

    /// OS acceptance only; an error may leave a partial tail.
    pub fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.file
            .write_all(bytes)
            .map_err(|error| context("append pinned recovery", &self.relative, error))
    }

    pub fn truncate(&mut self, length: u64) -> Result<(), String> {
        self.file
            .set_len(length)
            .map_err(|error| context("truncate pinned recovery", &self.relative, error))
    }

    /// Flushes the pinned file and the parent entry that names it.
    pub fn sync(&self) -> Result<(), String> {
        self.file
            .sync_all()
            .map_err(|error| context("sync pinned recovery", &self.relative, error))?;
        sync_directory(
            &self.directory,
            "sync pinned recovery parent",
            &self.relative,
        )
    }

    /// Durably unlinks the canonical name only while it names the pinned
    /// inode. Foreign bytes there are refused untouched.
    pub fn remove(&self, root: &Path) -> Result<(), String> {
        if self.canonical_is_owned(root)? {
            let leaf = Path::new(&self.relative).file_name().unwrap();
            unlinkat(&self.directory, leaf, AtFlags::empty()).map_err(|e| e.to_string())?;
        }
        sync_directory(
            &self.directory,
            "sync pinned recovery removal",
            &self.relative,
        )
    }
}
